/*
  EcoVital Node - cloud + voice firmware (ESP32 + ST7735 160x128 + MAX98357A speaker)

  Keeps the smart-display UI and sensor logic. Adds:
    - Wi-Fi upload of all 4 readings to the EcoVital web app (batched, buffered in RAM if offline)
    - the AI voice: when the server decides something is worth saying, this node downloads the
      speech and plays it through the MAX98357A amplifier
  Network work runs on core 0 in its own task, so sensor reading and the display never wait on Wi-Fi.

  Sensors : GP2Y1010AU0F (Dust %), MQ135 (Air index %), DHT22 (Temp C, Hum %)
  Serial  : 115200 baud. 'c' = calibrate in clean air (saved). 't' = play a test beep. 'v' = speak last event. 'i' = Wi-Fi / cloud status.

  Libraries: Adafruit GFX, Adafruit ST7735 and ST7789, DHT sensor library, Adafruit Unified Sensor
  Board    : ESP32 Dev Module (Arduino-ESP32 core 2.x or 3.x)

  WIRING (all grounds joined)
  TFT ST7735 : CS->15, DC->2, RST->4, SDA(MOSI)->23, SCK->18, LED->3.3V, VCC->3.3V
  DHT22      : DATA->13 (10k pull-up to 3.3V if bare sensor)
  MQ135      : AO -> [10k] -> 34 -> [20k] -> GND
  GP2Y dust  : V-LED via 150R + 220uF to 5V, LED->27, Vo -> [10k] -> 35 -> [20k] -> GND
  MAX98357A  : BCLK->26, LRC->25, DIN->22, VIN->5V, GND->GND, SD left floating (or 3.3V), GAIN floating
*/

#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include <DHT.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <ArduinoOTA.h>
#include <HTTPUpdate.h>
#include <esp_system.h>
#if __has_include(<esp_mac.h>)
  #include <esp_mac.h>
#endif
// Arduino-ESP32 3.x uses the new I2S driver; including the old one there crashes at boot (driver conflict).
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  #define NEW_I2S 1
  #include <driver/i2s_std.h>
#else
  #define NEW_I2S 0
  #include <driver/i2s.h>
#endif

#include "logo.h"
#include "welcome.h"
#include "clips.h"     // offline spoken alerts (set Tools > Partition Scheme > Minimal SPIFFS (1.9MB APP with OTA))

// =====================================================================
//  EDIT THESE
//====================================================================
#define DEFAULT_SSID  "YOUR_WIFI_NAME"
#define DEFAULT_PASS  "YOUR_WIFI_PASSWORD"// 
#define DEFAULT_BASE  "https://ecovital-phi.vercel.app"   // no trailing slash
#define DEFAULT_KEY   "evk_6450a3caa5e01e24638ef4e6"
#define DEVICE_LOC   "FUTO, Owerri, Nigeria"
#define DEVICE_LAT   5.385f
#define DEVICE_LNG   6.998f
#define FW_VERSION "2.7"
// The DEFAULT_ values above are only used the very first time. After that the pod uses what was saved from
// its setup page (join the "EcoVital-XXXX" Wi-Fi, or open http://<pod-ip>/), so you never reflash to change them.

String cfgSsid, cfgPass, cfgBase, cfgKey, cfgTok;   // cfgTok = this pod's private token from the cloud                 // saved settings
char deviceId[24]   = "ecovital-000000";                  // from the chip's MAC address, never changes
char deviceName[40] = "EcoVital Pod";
char claimCode[8]   = "------";                           // 6-character pairing code shown on the pod
char macStr[18]     = "00:00:00:00:00:00";
char apName[20]     = "EcoVital-0000";
volatile float spkVol = 1.0f;                             // 0.0 - 1.0, set from the app
volatile bool  muted  = false;
volatile bool restartReq = false;       // set by app restart command
volatile bool sosRequest = false;       // app SOS alarm
volatile bool sosActive = false;        // visual SOS screen flag
uint32_t sosStarted = 0;
bool wasSos = false;
uint32_t wifiDrops = 0;

#define WIFI_SSID   cfgSsid.c_str()
#define WIFI_PASS   cfgPass.c_str()
#define API_BASE    cfgBase.c_str()
#define DEVICE_KEY  cfgKey.c_str()
#define DEVICE_ID   deviceId
#define DEVICE_NAME deviceName

#define OUT_HEADROOM 0.80f       // loudest peak = 80% of full scale: full scale clips the amp and speaker and sounds scrambled
#define SPEAKER_VOLUME (spkVol * OUT_HEADROOM)    // loudness of beeps and AI voice, set from the app
#define CLIP_VOLUME (spkVol * OUT_HEADROOM)
#define WELCOME_VOLUME (spkVol * OUT_HEADROOM)
#define UPLOAD_EVERY_MS 3000    // how often readings are sent
#define SAMPLE_EVERY_MS 2000     // how often a reading is recorded
// =====================================================================

// ---------- TFT ----------
#define TFT_CS   15
#define TFT_DC    2
#define TFT_RST   4
#define TAB INITR_BLACKTAB      // try INITR_GREENTAB / INITR_REDTAB if edges or colours look wrong
Adafruit_ST7735 tft = Adafruit_ST7735(TFT_CS, TFT_DC, TFT_RST);

GFXcanvas16 cardCanvas(74, 51);
GFXcanvas16 headerCanvas(160, 15);

// ---------- SENSOR PINS ----------
#define PIN_MQ       34
#define PIN_DUST_VO  35
#define PIN_DUST_LED 27
#define PIN_DHT      13
#define DHTTYPE      DHT22

// ---------- AMPLIFIER PINS ----------
#define I2S_BCLK 26
#define I2S_LRC  25
#define I2S_DIN  22
#define SPEECH_RATE 24000        // the server sends 16-bit mono PCM at 24 kHz

#define MQ_WARMUP_MS 60000UL

const float DIVIDER = 1.5f;
float dustBaselineV = 0.60f;
float airBaselineV  = 0.80f;
bool  airCalibrated = false;
bool  mqReady = false;

DHT dht(PIN_DHT, DHTTYPE);
Preferences prefs;

unsigned long lastSample = 0, lastDht = 0, lastFrame = 0, lastPulse = 0, lastRecord = 0;

float dustSumMv = 0, mqSumMv = 0;
int   sampleN = 0;
float latestDustV = 0, latestMqV = 0;

// latest readings for upload (core 1 writes, only read when building a sample)
float curDust = NAN, curAir = NAN, curTemp = NAN, curHum = NAN;
bool  dhtTried = false, dhtFailed = false;

// ---------- PALETTE (RGB565) ----------
#define COL_BG         0x0842
#define COL_CARD       0x10A4
#define COL_CARD_EDGE  0x2146
#define COL_TRACK      0x1926
#define COL_SUBTEXT    0x8C73
#define COL_MINT       0x1FE9
#define COL_CYAN       0x269F
#define COL_AMBER      0xFD63
#define COL_CORAL      0xF986

// ---------- TYPES (must stay above the first function: Arduino generates prototypes there) ----------
struct SmartWidget {
  int x, y;
  const char* title;
  const char* unit;
  float vmin, vmax;
  float warn, bad;
  bool invertStatus;
  float lowWarn;
  const char* words[4];
  uint16_t goodColor;
  float targetVal, animVal;
  bool valid;
  int lastAng, lastInt;
  uint8_t lastLevel;
  bool lastValid;
};

// One recorded reading. st: 0 = not sent (e.g. still warming up), 1 = value, 2 = sensor failed (sent as null)
struct Sample {
  uint32_t ms;
  float v[4];       // dust, air, temp, hum
  uint8_t st[4];
};

// ---------- RING BUFFER (survives Wi-Fi outages, about 1 hour; readings keep their age and are sent later) ----------
#define RING 720
#define BATCH 24
Sample ring[RING];
volatile int rHead = 0, rCount = 0;
portMUX_TYPE ringMux = portMUX_INITIALIZER_UNLOCKED;

void ringPush(const Sample& s) {
  portENTER_CRITICAL(&ringMux);
  int idx = (rHead + rCount) % RING;
  ring[idx] = s;
  if (rCount < RING) rCount++; else rHead = (rHead + 1) % RING;   // full: drop the oldest
  portEXIT_CRITICAL(&ringMux);
}
int ringPeek(Sample* out, int maxN) {
  portENTER_CRITICAL(&ringMux);
  int n = rCount < maxN ? rCount : maxN;
  for (int i = 0; i < n; i++) out[i] = ring[(rHead + i) % RING];
  portEXIT_CRITICAL(&ringMux);
  return n;
}
void ringDrop(int n) {
  portENTER_CRITICAL(&ringMux);
  if (n > rCount) n = rCount;
  rHead = (rHead + n) % RING;
  rCount -= n;
  portEXIT_CRITICAL(&ringMux);
}
int ringCount() { return rCount; }

// ---------- NETWORK STATE (shown in the header) ----------
volatile uint8_t netState = 0;          // 0 no Wi-Fi, 1 Wi-Fi but not uploading, 2 uploading OK
volatile bool speaking = false;
unsigned long audioQuietUntil = 0;   // sensors are ignored while the speaker plays (its current makes the readings jump)
volatile uint32_t lastOkMs = 0;
volatile int lastEventId = 0;
volatile bool replayRequested = false;

// ---------- RING GEOMETRY ----------
#define RING_BOX 40
#define RING_CX  22
#define RING_CY  26
#define R_OUT    19
#define R_IN     14

uint8_t ringMask[RING_BOX][RING_BOX];
uint8_t ringProg[RING_BOX][RING_BOX];

void initRingLUT() {
  for (int y = 0; y < RING_BOX; y++) {
    for (int x = 0; x < RING_BOX; x++) {
      float dx = x - 20.0f;
      float dy = y - 20.0f;
      float r = sqrtf(dx * dx + dy * dy);
      ringMask[y][x] = 0;
      if (r >= R_IN - 0.5f && r <= R_OUT + 0.5f) {
        float deg = atan2f(dy, dx) * RAD_TO_DEG;
        if (deg < 0) deg += 360.0f;
        float rel = deg - 150.0f;
        if (rel < 0) rel += 360.0f;
        if (rel <= 240.0f) {
          ringMask[y][x] = (r < R_IN + 0.3f || r > R_OUT - 0.3f) ? 2 : 1;
          ringProg[y][x] = (uint8_t)rel;
        }
      }
    }
  }
}

uint16_t blendHalf(uint16_t c1, uint16_t c2) {
  return (((c1 & 0xF7DE) >> 1) + ((c2 & 0xF7DE) >> 1));
}

//                   x   y   title   unit  min  max  warn bad  invert lowWarn words                              good    target anim valid  last...
SmartWidget wAir  = {  4, 15, "AIR",  "%",  0, 100,  70,  45, true,  NAN, {"GOOD","FAIR","POOR","--"},  COL_MINT, 100, 100, false, -1, -1, 255, false };
SmartWidget wDust = { 82, 15, "DUST", "%",  0, 100,  35,  65, false, NAN, {"LOW", "MOD", "HIGH","--"},  COL_MINT,   0,   0, false, -1, -1, 255, false };
SmartWidget wTemp = {  4, 67, "TEMP", "C",  0,  50,  30,  36, false, 16,  {"OK",  "WARM","HOT", "COOL"},COL_CYAN,  24,  24, false, -1, -1, 255, false };
SmartWidget wHum  = { 82, 67, "HUM",  "%",  0, 100,  68,  82, false, 30,  {"OK",  "DAMP","WET", "DRY"}, COL_MINT,  50,  50, false, -1, -1, 255, false };

SmartWidget* widgets[4] = { &wAir, &wDust, &wTemp, &wHum };

uint8_t levelOf(const SmartWidget& w, float v) {
  if (w.invertStatus) {
    if (v <= w.bad)  return 2;
    if (v <= w.warn) return 1;
    return 0;
  }
  if (!isnan(w.lowWarn) && v < w.lowWarn) return 3;
  if (v >= w.bad)  return 2;
  if (v >= w.warn) return 1;
  return 0;
}

uint16_t levelColor(const SmartWidget& w, uint8_t lvl) {
  if (!w.valid) return COL_TRACK;
  if (lvl == 0) return w.goodColor;
  if (lvl == 2) return COL_CORAL;
  return COL_AMBER;
}

const char* levelWord(const SmartWidget& w, uint8_t lvl) {
  if (!w.valid) return "WAIT";
  return w.words[lvl];
}

int fillAngleOf(const SmartWidget& w) {
  if (!w.valid) return 0;
  float frac = constrain((w.animVal - w.vmin) / (w.vmax - w.vmin), 0.0f, 1.0f);
  return (int)(frac * 240.0f);
}

bool widgetChanged(SmartWidget& w) {
  uint8_t lvl = w.valid ? levelOf(w, w.animVal) : 254;
  int ang = fillAngleOf(w);
  int iv  = w.valid ? (int)roundf(w.animVal) : -1;
  if (ang == w.lastAng && iv == w.lastInt && lvl == w.lastLevel && w.valid == w.lastValid) return false;
  w.lastAng = ang; w.lastInt = iv; w.lastLevel = lvl; w.lastValid = w.valid;
  return true;
}

void feed(SmartWidget& w, float v, float alpha = 0.35f) {
  if (!w.valid) {
    w.targetVal = v;
    w.animVal = v;
    w.valid = true;
  } else {
    w.targetVal += alpha * (v - w.targetVal);
  }
}

void animate(SmartWidget& w) {
  if (!w.valid) return;
  float diff = w.targetVal - w.animVal;
  if (fabsf(diff) < 0.05f) w.animVal = w.targetVal;
  else w.animVal += diff * 0.18f;
}

// ---------- RENDER ----------
void renderWidget(SmartWidget& w) {
  uint8_t lvl = w.valid ? levelOf(w, w.animVal) : 0;
  uint16_t accent = levelColor(w, lvl);
  float frac = w.valid ? constrain((w.animVal - w.vmin) / (w.vmax - w.vmin), 0.0f, 1.0f) : 0.0f;
  uint8_t fillAngle = (uint8_t)(frac * 240.0f);

  cardCanvas.fillScreen(COL_BG);
  cardCanvas.fillRoundRect(0, 0, 74, 51, 7, COL_CARD);
  cardCanvas.drawRoundRect(0, 0, 74, 51, 7, COL_CARD_EDGE);

  int ox = RING_CX - 20;
  int oy = RING_CY - 20;
  uint16_t trackEdge  = blendHalf(COL_TRACK, COL_CARD);
  uint16_t accentEdge = blendHalf(accent, COL_CARD);

  for (int y = 0; y < RING_BOX; y++) {
    for (int x = 0; x < RING_BOX; x++) {
      uint8_t m = ringMask[y][x];
      if (!m) continue;
      bool lit = (w.valid && ringProg[y][x] <= fillAngle);
      uint16_t c = lit ? ((m == 2) ? accentEdge : accent)
                       : ((m == 2) ? trackEdge  : COL_TRACK);
      cardCanvas.drawPixel(ox + x, oy + y, c);
    }
  }

  float startRad = 150.0f * DEG_TO_RAD;
  float rMid = (R_IN + R_OUT) * 0.5f;
  cardCanvas.fillCircle((int)roundf(RING_CX + cosf(startRad) * rMid),
                        (int)roundf(RING_CY + sinf(startRad) * rMid), 2, w.valid ? accent : COL_TRACK);
  if (w.valid) {
    float tipRad = (150.0f + frac * 240.0f) * DEG_TO_RAD;
    int tx = (int)roundf(RING_CX + cosf(tipRad) * rMid);
    int ty = (int)roundf(RING_CY + sinf(tipRad) * rMid);
    cardCanvas.fillCircle(tx, ty, 3, accent);
    cardCanvas.fillCircle(tx, ty, 1, ST77XX_WHITE);
  }

  char valBuf[8];
  if (w.valid) snprintf(valBuf, sizeof(valBuf), "%d", (int)roundf(w.animVal));
  else strcpy(valBuf, "--");
  int vLen = strlen(valBuf);
  cardCanvas.setTextSize(1);
  cardCanvas.setTextColor(ST77XX_WHITE);
  cardCanvas.setCursor(RING_CX - (vLen * 6) / 2, RING_CY - 5);
  cardCanvas.print(valBuf);

  int uLen = strlen(w.unit);
  cardCanvas.setTextColor(COL_SUBTEXT);
  cardCanvas.setCursor(RING_CX - (uLen * 6) / 2, RING_CY + 5);
  cardCanvas.print(w.unit);

  cardCanvas.setTextColor(COL_SUBTEXT);
  cardCanvas.setCursor(44, 10);
  cardCanvas.print(w.title);

  cardCanvas.setTextColor(accent);
  cardCanvas.setCursor(44, 23);
  cardCanvas.print(levelWord(w, lvl));

  cardCanvas.drawFastHLine(44, 38, 24, COL_TRACK);
  if (w.valid) cardCanvas.drawFastHLine(44, 38, (int)(frac * 24), accent);

  tft.drawRGBBitmap(w.x, w.y, cardCanvas.getBuffer(), 74, 51);
}

int lastHeaderState = -1;
int lastHeaderBlink = -1;
int lastHeaderNet = -1;
int lastHeaderSpeak = -2;
int lastHeaderWifi = -2;
String lastFooter = "";

int wifiBars() {                                  // 0-4 bars from signal strength, -1 = not connected
  if (WiFi.status() != WL_CONNECTED) return -1;
  int r = WiFi.RSSI();
  return r > -55 ? 4 : r > -65 ? 3 : r > -75 ? 2 : r > -85 ? 1 : 0;
}

void updateHeader(unsigned long now) {
  bool any = false;
  uint8_t worst = 0;
  bool airDustBad = false;
  for (int i = 0; i < 4; i++) {
    SmartWidget& w = *widgets[i];
    if (!w.valid) continue;
    any = true;
    uint8_t lvl = levelOf(w, w.animVal);
    if (lvl == 2) {
      worst = 2;
      if (&w == &wAir || &w == &wDust) airDustBad = true;
    } else if ((lvl == 1 || lvl == 3) && worst < 1) {
      worst = 1;
    }
  }

  int state;
  if (!any) state = 0;
  else if (worst == 2) state = airDustBad ? 3 : 4;
  else if (worst == 1) state = 2;
  else state = 1;

  int blink = (now / 700) & 1;
  int net = netState;
  int bars = wifiBars();
  int speak = speaking ? (int)((now / 130) % 6) : -1;     // animated equaliser while speaking
  if (state == lastHeaderState && blink == lastHeaderBlink && net == lastHeaderNet && speak == lastHeaderSpeak && bars == lastHeaderWifi) return;
  lastHeaderState = state; lastHeaderBlink = blink; lastHeaderNet = net; lastHeaderSpeak = speak; lastHeaderWifi = bars;

  const char* text;
  uint16_t col;
  switch (state) {
    case 1:  text = "ALL GOOD";  col = COL_MINT;    break;
    case 2:  text = "MODERATE";  col = COL_AMBER;   break;
    case 3:  text = "POOR AIR";  col = COL_CORAL;   break;
    case 4:  text = "ATTENTION"; col = COL_CORAL;   break;
    default: text = "STARTING";  col = COL_SUBTEXT; break;
  }

  headerCanvas.fillScreen(COL_BG);
  headerCanvas.setTextSize(1);
  headerCanvas.setTextColor(ST77XX_WHITE);
  headerCanvas.setCursor(4, 4);
  headerCanvas.print("EcoVital");

  if (speak >= 0) {
    static const uint8_t pat[6][3] = {{3,8,5},{6,4,8},{8,6,3},{4,8,6},{7,3,8},{5,7,4}};
    for (int b = 0; b < 3; b++) {
      int h = pat[speak][b];
      headerCanvas.fillRect(55 + b * 3, 11 - h, 2, h, ST77XX_WHITE);
    }
  }

  headerCanvas.fillRoundRect(63, 1, 72, 13, 6, COL_CARD);
  headerCanvas.drawRoundRect(63, 1, 72, 13, 6, COL_CARD_EDGE);
  headerCanvas.fillCircle(70, 7, 2, blink ? col : blendHalf(col, COL_CARD));
  headerCanvas.setTextColor(col);
  headerCanvas.setCursor(77, 4);
  headerCanvas.print(text);

  // Wi-Fi: four bars (green = app online, amber = Wi-Fi only), or a red cross when disconnected
  if (bars >= 0) {
    uint16_t lit = (net == 2) ? COL_MINT : COL_AMBER;
    for (int i = 0; i < 4; i++) {
      int h = 3 + i * 2;
      headerCanvas.fillRect(141 + i * 4, 12 - h + 1, 3, h, i < bars ? lit : COL_TRACK);
    }
  } else {
    for (int i = 0; i < 4; i++) headerCanvas.fillRect(141 + i * 4, 12 - (3 + i * 2) + 1, 3, 3 + i * 2, COL_CARD_EDGE);
    for (int d = 0; d < 2; d++) {
      headerCanvas.drawLine(141 + d, 3, 154 + d, 12, COL_CORAL);
      headerCanvas.drawLine(154 + d, 3, 141 + d, 12, COL_CORAL);
    }
  }

  tft.drawRGBBitmap(0, 0, headerCanvas.getBuffer(), 160, 15);
}

void drawFooter() {                                 // bottom line: IP address, or "Disconnected", and readings saved for later
  bool on = WiFi.status() == WL_CONNECTED;
  String key = on ? WiFi.localIP().toString() : String("-");
  int saved = (netState != 2) ? ringCount() : 0;
  key += "|"; key += saved;
  if (key == lastFooter) return;
  lastFooter = key;
  tft.fillRect(0, 118, 160, 10, COL_BG);
  tft.setTextSize(1);
  tft.setCursor(5, 120);
  if (on) { tft.setTextColor(COL_SUBTEXT); tft.print("IP "); tft.print(WiFi.localIP().toString()); }
  else    { tft.setTextColor(COL_CORAL);   tft.print("Disconnected"); }
  if (saved > 0) {
    char b[16];
    snprintf(b, sizeof(b), "saved %d", saved);
    tft.setTextColor(COL_AMBER);
    tft.setCursor(160 - 5 - (int)strlen(b) * 6, 120);
    tft.print(b);
  }
}

// ---------- SENSORS ----------
float readDustVoltage(int n = 10) {
  float sum = 0;
  for (int i = 0; i < n; i++) {
    digitalWrite(PIN_DUST_LED, LOW);
    delayMicroseconds(280);
    sum += analogReadMilliVolts(PIN_DUST_VO);
    digitalWrite(PIN_DUST_LED, HIGH);
    delayMicroseconds(9500);
  }
  return (sum / n) / 1000.0f * DIVIDER;
}

float readMqVoltage(int n = 12) {
  float sum = 0;
  for (int i = 0; i < n; i++) {
    sum += analogReadMilliVolts(PIN_MQ);
    delay(1);
  }
  return (sum / n) / 1000.0f * DIVIDER;
}

void takePulse() {
  digitalWrite(PIN_DUST_LED, LOW);
  delayMicroseconds(280);
  dustSumMv += analogReadMilliVolts(PIN_DUST_VO);
  digitalWrite(PIN_DUST_LED, HIGH);
  delayMicroseconds(35); // Allow ADC supply rail to settle after LED high
  int m1 = analogReadMilliVolts(PIN_MQ);
  int m2 = analogReadMilliVolts(PIN_MQ);
  int m3 = analogReadMilliVolts(PIN_MQ);
  int med = (m1 > m2) ? ((m2 > m3) ? m2 : ((m1 > m3) ? m3 : m1)) : ((m1 > m3) ? m1 : ((m2 > m3) ? m3 : m2));
  mqSumMv += med;
  sampleN++;
}

float calcDustPercent(float dustV) {
  float deltaV = dustV - dustBaselineV;
  if (deltaV < 0) deltaV = 0;
  return constrain((deltaV / 1.80f) * 100.0f, 0.0f, 100.0f);
}

float calcAirQualityPercent(float mqV) {
  float riseV = mqV - airBaselineV;
  if (riseV < 0) riseV = 0;
  return constrain(100.0f - (riseV / 2.00f) * 100.0f, 0.0f, 100.0f);
}

// ---------- AUDIO ----------
bool i2sOpen = false;

#if NEW_I2S
static i2s_chan_handle_t txChan = NULL;

bool i2sStart() {
  if (muted) return false;
  i2s_chan_config_t cc = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  cc.auto_clear = true;
  cc.dma_desc_num = 8;
  cc.dma_frame_num = 256;
  if (i2s_new_channel(&cc, &txChan, NULL) != ESP_OK) { txChan = NULL; return false; }
  i2s_std_config_t sc = {};
  sc.clk_cfg  = I2S_STD_CLK_DEFAULT_CONFIG(SPEECH_RATE);
  sc.slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO);
  sc.gpio_cfg.mclk = I2S_GPIO_UNUSED;
  sc.gpio_cfg.bclk = (gpio_num_t)I2S_BCLK;
  sc.gpio_cfg.ws   = (gpio_num_t)I2S_LRC;
  sc.gpio_cfg.dout = (gpio_num_t)I2S_DIN;
  sc.gpio_cfg.din  = I2S_GPIO_UNUSED;
  if (i2s_channel_init_std_mode(txChan, &sc) != ESP_OK) { i2s_del_channel(txChan); txChan = NULL; return false; }
  if (i2s_channel_enable(txChan) != ESP_OK) { i2s_del_channel(txChan); txChan = NULL; return false; }
  i2sOpen = true;
  return true;
}

void i2sStop() {
  if (!i2sOpen) return;
  delay(60);                        // let the last samples play out
  i2s_channel_disable(txChan);
  i2s_del_channel(txChan);
  txChan = NULL;
  i2sOpen = false;
}

void i2sWrite(const void* data, size_t bytes) {
  size_t written = 0;
  if (txChan) i2s_channel_write(txChan, data, bytes, &written, 2000);
}
#else
bool i2sStart() {
  if (muted) return false;
  i2s_config_t cfg = {};
  cfg.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX);
  cfg.sample_rate = SPEECH_RATE;
  cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  cfg.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT;     // same sample to both channels
  cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  cfg.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  cfg.dma_buf_count = 8;
  cfg.dma_buf_len = 256;
  cfg.use_apll = false;
  cfg.tx_desc_auto_clear = true;
  if (i2s_driver_install(I2S_NUM_0, &cfg, 0, NULL) != ESP_OK) return false;
  i2s_pin_config_t pins = {};
  pins.mck_io_num = I2S_PIN_NO_CHANGE;
  pins.bck_io_num = I2S_BCLK;
  pins.ws_io_num = I2S_LRC;
  pins.data_out_num = I2S_DIN;
  pins.data_in_num = I2S_PIN_NO_CHANGE;
  if (i2s_set_pin(I2S_NUM_0, &pins) != ESP_OK) { i2s_driver_uninstall(I2S_NUM_0); return false; }
  i2s_zero_dma_buffer(I2S_NUM_0);
  i2sOpen = true;
  return true;
}

void i2sStop() {
  if (!i2sOpen) return;
  i2s_zero_dma_buffer(I2S_NUM_0);
  delay(40);
  i2s_driver_uninstall(I2S_NUM_0);
  i2sOpen = false;
}

void i2sWrite(const void* data, size_t bytes) {
  size_t written = 0;
  i2s_write(I2S_NUM_0, data, bytes, &written, portMAX_DELAY);
}
#endif

// Mono 16-bit little-endian PCM in, stereo out with volume. Handles a split sample between chunks.
static int carryByte = -1;
void writePcm(const uint8_t* data, size_t len) {
  int16_t frames[512 * 2];
  int fi = 0;
  size_t i = 0;
  while (i < len || false) {
    int16_t s;
    if (carryByte >= 0) { s = (int16_t)(carryByte | (data[i] << 8)); carryByte = -1; i++; }
    else if (i + 1 < len) { s = (int16_t)(data[i] | (data[i + 1] << 8)); i += 2; }
    else { carryByte = data[i]; i++; break; }
    int32_t v = (int32_t)(s * SPEAKER_VOLUME);
    if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
    frames[fi++] = (int16_t)v;
    frames[fi++] = (int16_t)v;
    if (fi >= 512 * 2) {
      i2sWrite(frames, fi * sizeof(int16_t));
      fi = 0;
    }
  }
  if (fi) {
    i2sWrite(frames, fi * sizeof(int16_t));
  }
}

void playToneVol(float freq, int ms, float vol) {
  int n = SPEECH_RATE * ms / 1000;
  int16_t frames[256 * 2];
  int fi = 0;
  for (int i = 0; i < n; i++) {
    float env = 1.0f;
    if (i < 200) env = i / 200.0f; else if (i > n - 200) env = (n - i) / 200.0f;
    int16_t s = (int16_t)(sinf(2 * PI * freq * i / SPEECH_RATE) * 30000 * vol * env);
    frames[fi++] = s; frames[fi++] = s;
    if (fi >= 256 * 2) { i2sWrite(frames, fi * 2); fi = 0; }
  }
  if (fi) i2sWrite(frames, fi * 2);
}

void playTone(float freq, int ms) { playToneVol(freq, ms, SPEAKER_VOLUME); }

void playSos() {                                 // loud emergency siren, sounds even when muted or low volume
  if (!i2sStart()) { Serial.println("[sos] I2S start failed"); return; }
  speaking = true;
  int16_t z[256 * 2] = {0};
  i2sWrite(z, sizeof(z));
  float vol = (spkVol < 0.7f ? 0.7f : spkVol) * OUT_HEADROOM;
  for (int i = 0; i < 6; i++) { playToneVol(1000, 280, vol); playToneVol(700, 280, vol); }
  i2sWrite(z, sizeof(z));
  speaking = false;
  i2sStop();
}

void playSiren() {                               // loud two-tone siren (still silent if the pod is muted)
  if (!i2sStart()) return;
  speaking = true;
  int16_t z[256 * 2] = {0};
  i2sWrite(z, sizeof(z));
  for (int k = 0; k < 8; k++) { playToneVol(960, 230, 0.8f); playToneVol(1400, 230, 0.8f); }
  i2sWrite(z, sizeof(z));
  speaking = false;
  i2sStop();
}

void beepPattern(int count) {
  if (!i2sStart()) return;
  speaking = true;
  for (int i = 0; i < count; i++) { playTone(880, 140); delay(90); }
  speaking = false;
  i2sStop();
}

// Download and play the speech for one event
bool playSpeech(int eventId) {
  char url[160];
  snprintf(url, sizeof(url), "%s/api/tts/%d", API_BASE, eventId);

  WiFiClientSecure sec;
  WiFiClient plain;
  HTTPClient http;
  bool https = strncmp(API_BASE, "https", 5) == 0;
  if (https) { sec.setInsecure(); http.begin(sec, url); }   // see README: add the Vercel root CA to verify the server
  else http.begin(plain, url);
  http.useHTTP10(true);                // plain Content-Length body, no chunked encoding
  http.setTimeout(20000);
  int code = http.GET();
  if (code != 200) {
    Serial.printf("[voice] speech download failed (HTTP %d), playing beeps\n", code);
    http.end();
    beepPattern(code == 404 ? 1 : 2);
    return false;
  }

  if (!i2sStart()) { Serial.println("[voice] I2S start failed"); http.end(); return false; }
  speaking = true;
  carryByte = -1;

  // 80 ms of silence first so the amplifier wakes up without a pop
  { int16_t z[256 * 2] = {0}; i2sWrite(z, sizeof(z)); }

  WiFiClient* stream = http.getStreamPtr();
  int remaining = http.getSize();      // -1 if unknown
  uint8_t buf[1024];
  uint32_t lastData = millis();
  size_t total = 0;
  while (remaining != 0) {
    size_t avail = stream->available();
    if (!avail) {
      if (!stream->connected() && !stream->available()) break;
      if (millis() - lastData > 6000) { Serial.println("[voice] stream stalled"); break; }
      delay(2);
      continue;
    }
    int n = stream->readBytes(buf, avail < sizeof(buf) ? avail : sizeof(buf));
    if (n <= 0) continue;
    lastData = millis();
    if (remaining > 0) remaining -= n;
    total += n;
    writePcm(buf, n);
  }
  Serial.printf("[voice] played %u bytes (~%.1f s)\n", (unsigned)total, total / 2.0f / SPEECH_RATE);
  http.end();
  speaking = false;
  i2sStop();
  return total > 4000;
}

// ---------- OFFLINE ALERTS: the pod talks on its own, no Wi-Fi needed ----------
// Same limits as the web app. When the cloud is working the AI speaks instead;
// if the AI has not spoken within 35 s of a problem, the pod says its own recorded advice.
volatile uint32_t lastCloudSpeakMs = 0;
volatile int clipRequest = -1;
volatile int beepRequest = 0;
int testClip = 0;

enum { ST_OK = 0, ST_WATCH_H = 1, ST_BAD_H = 2, ST_WATCH_L = 3, ST_BAD_L = 4 };
struct Lim { float wH, bH, wL, bL, hyst; };
//                       watchHigh badHigh watchLow badLow  hysteresis
static Lim LIM[4] = { {35,  65,  NAN, NAN, 3.0f},    // 0 dust
                            {NAN, NAN, 70,  45,  3.0f},    // 1 air index (low is bad)
                            {30,  36,  16,  NAN, 0.5f},    // 2 temperature
                            {68,  82,  30,  NAN, 2.0f} };  // 3 humidity

uint8_t  locStatus[4]  = {0, 0, 0, 0};          // confirmed state
uint8_t  candStatus[4] = {0, 0, 0, 0};          // state waiting to be confirmed
uint32_t candSince[4]  = {0, 0, 0, 0};
uint32_t lastClipAt[4] = {0, 0, 0, 0};
uint32_t lastRapidAt = 0;
float    hist[4][24];                           // last 2 minutes, one value per 5 s
uint8_t  histN[4] = {0, 0, 0, 0};
int      pendingClip = -1, pendingPrio = 0;
uint32_t pendingAt = 0;

// ----- on-device "mini AI": trends, early warnings and plain advice (works with no Wi-Fi) -----
#define TREND_N 180                              // one point every 20 s = the last hour, for the pod's own web page
float   trendV[4][TREND_N];
int     trendNext = 0, trendFilled = 0;
float   slopeMin[4] = {0, 0, 0, 0};              // change per minute over the last 2 minutes
int     predMin[4]  = {-1, -1, -1, -1};          // minutes until it leaves the healthy range, -1 = not heading there
char    adviceText[112] = "Reading the sensors...";
uint8_t adviceLevel = 0;                         // 0 fine, 1 watch, 2 bad, 3 early warning
uint32_t adviceAt = 0;
const char* rapidMsg = nullptr;
uint32_t rapidMsgAt = 0;

// ----- gas / fumes alarm: a fast drop of the air index (MQ135 reacts to many gases and fumes, but it cannot say which) -----
#define GAS_DROP_POINTS 15.0f    // alarm when the air index falls this far below its slow baseline...
#define GAS_LOW_LEVEL   40.0f    // ...or goes under this level, for at least 1 second
bool gasAlarm = false, wasGas = false, gasTrig = false;
float airRef = NAN;                              // slow baseline of the air index
uint32_t gasWarmAt = 0, gasLowSince = 0, gasClearSince = 0, gasStarted = 0, gasLastSound = 0, gasTestUntil = 0;
volatile int sirenRequest = 0;
enum Cause { C_NONE = 0, C_SMOKE, C_GAS, C_DUST, C_STUFFY };
uint8_t causeId = C_NONE;
uint32_t apOpenedAt = 0;
volatile bool apActive = false;                 // the pod's own setup Wi-Fi is open
volatile bool uploadNow = false;

uint8_t classifyLocal(int m, float v, uint8_t prev) {
  const Lim& L = LIM[m];
  if (!isnan(L.bH) && (v >= L.bH || (prev == ST_BAD_H && v > L.bH - L.hyst))) return ST_BAD_H;
  if (!isnan(L.bL) && (v <= L.bL || (prev == ST_BAD_L && v < L.bL + L.hyst))) return ST_BAD_L;
  if (!isnan(L.wH) && (v >= L.wH || ((prev == ST_WATCH_H || prev == ST_BAD_H) && v > L.wH - L.hyst))) return ST_WATCH_H;
  if (!isnan(L.wL) && (v <= L.wL || ((prev == ST_WATCH_L || prev == ST_BAD_L) && v < L.wL + L.hyst))) return ST_WATCH_L;
  return ST_OK;
}
int sevOf(uint8_t st) { return st == ST_OK ? 0 : (st == ST_BAD_H || st == ST_BAD_L) ? 2 : 1; }

int clipFor(int m, uint8_t st) {
  switch (m) {
    case 0: return st == ST_BAD_H ? CLIP_DUST_BAD : CLIP_DUST_WATCH;
    case 1: return st == ST_BAD_L ? CLIP_AIR_BAD : CLIP_AIR_WATCH;
    case 2: if (st == ST_BAD_H) return CLIP_HOT_BAD; if (st == ST_WATCH_H) return CLIP_HOT_WATCH; return CLIP_COLD;
    default: if (st == ST_BAD_H) return CLIP_HUM_VHIGH; if (st == ST_WATCH_H) return CLIP_HUM_HIGH; return CLIP_HUM_LOW;
  }
}

void queueClip(int id, int prio, uint32_t now) {
  if (gasAlarm && (id == CLIP_AIR_BAD || id == CLIP_GAS)) return;     // the siren already says this
  if (pendingClip < 0 || prio > pendingPrio) { pendingClip = id; pendingPrio = prio; pendingAt = now; }
}

void localAlertStep(uint32_t now) {            // called once per recorded reading (every 5 s)
  float v[4] = { curDust, mqReady ? curAir : NAN, dhtFailed ? NAN : curTemp, dhtFailed ? NAN : curHum };
  for (int m = 0; m < 4; m++) {
    if (isnan(v[m])) continue;
    if (histN[m] == 24) { memmove(hist[m], hist[m] + 1, 23 * sizeof(float)); histN[m] = 23; }
    hist[m][histN[m]++] = v[m];
  }
  if (now < 30000) return;                     // let the sensors settle after power-up

  for (int m = 0; m < 4; m++) {
    if (isnan(v[m])) continue;
    uint8_t cand = classifyLocal(m, v[m], locStatus[m]);
    if (cand == locStatus[m]) { candStatus[m] = cand; continue; }
    if (cand != candStatus[m]) { candStatus[m] = cand; candSince[m] = now; continue; }
    if (now - candSince[m] < 10000) continue;   // must hold for 10 s before it counts
    uint8_t old = locStatus[m];
    locStatus[m] = cand;
    if (sevOf(cand) > sevOf(old)) {             // got worse: say what to do
      if (lastClipAt[m] == 0 || now - lastClipAt[m] >= 120000) {
        lastClipAt[m] = now;
        queueClip(clipFor(m, cand), sevOf(cand) == 2 ? 100 : 80, now);
      }
    } else if (sevOf(cand) < sevOf(old)) {      // got better
      bool allOk = true;
      for (int k = 0; k < 4; k++) if (locStatus[k] != ST_OK) allOk = false;
      queueClip(allOk ? CLIP_ALL_GOOD : CLIP_IMPROVING, 50, now);
    }
  }

  // rapid changes, even while still inside the limits
  if (lastRapidAt == 0 || now - lastRapidAt >= 300000) {
    if (histN[2] >= 18) {
      float d = hist[2][histN[2] - 1] - hist[2][0];
      if (d <= -1.5f) { lastRapidAt = now; rapidMsg = "Temperature is dropping rapidly. Close the windows or turn off the AC."; rapidMsgAt = now; queueClip(CLIP_TEMP_DROP, 70, now); }
      else if (d >= 1.5f) { lastRapidAt = now; rapidMsg = "Temperature is rising rapidly. Turn on the fan or AC."; rapidMsgAt = now; queueClip(CLIP_TEMP_RISE, 70, now); }
    }
    if (histN[0] >= 13 && locStatus[0] < ST_BAD_H && lastRapidAt != now) {
      float d = hist[0][histN[0] - 1] - hist[0][histN[0] - 13];
      if (d >= 25.0f) { lastRapidAt = now; rapidMsg = "Dust just spiked. Open a window or turn on the fan."; rapidMsgAt = now; queueClip(CLIP_DUST_SPIKE, 70, now); }
    }
  }
}

void pushTrend(uint32_t now) {
  static uint32_t last = 0;
  if (last && now - last < 20000) return;
  last = now ? now : 1;
  float v[4] = { curDust, mqReady ? curAir : NAN, dhtFailed ? NAN : curTemp, dhtFailed ? NAN : curHum };
  for (int m = 0; m < 4; m++) trendV[m][trendNext] = v[m];
  trendNext = (trendNext + 1) % TREND_N;
  if (trendFilled < TREND_N) trendFilled++;
}

// ----- "what is happening?" : reads how dust, air quality and temperature move TOGETHER (works with no Wi-Fi) -----
// smoke or burning : temperature up + dust up + air quality down
// dust only        : dust up while air quality holds
// gas or fumes     : air quality drops fast with no heat and no dust change (the MQ135 cannot say which gas)
// stuffy room      : air quality slowly worse with no heat and no dust change (poor ventilation, CO2 or fumes building up)
uint8_t lastCauseId = C_NONE;
uint32_t causeClipAt[5] = {0, 0, 0, 0, 0};
uint32_t causeSince = 0, causeSoundAt = 0;
const char* causeWord() { return causeId == C_SMOKE ? "smoke" : causeId == C_GAS ? "gas" : causeId == C_DUST ? "dust" : causeId == C_STUFFY ? "stuffy" : ""; }

void diagnoseStep(uint32_t now) {                 // called every 5 s
  if (histN[0] < 9 || histN[1] < 9 || histN[2] < 9 || !mqReady) { causeId = C_NONE; return; }
  int w = histN[0] < 12 ? histN[0] - 1 : 12;      // look back about one minute
  float dD = hist[0][histN[0] - 1] - hist[0][histN[0] - 1 - w];
  float dA = hist[1][histN[1] - 1] - hist[1][histN[1] - 1 - w];
  float dT = hist[2][histN[2] - 1] - hist[2][histN[2] - 1 - w];
  bool airWorse = dA <= -8.0f || locStatus[1] >= ST_WATCH_L;
  bool dustUp   = dD >= 10.0f || locStatus[0] != ST_OK;
  bool warmer   = dT >= 0.8f;
  uint8_t c = C_NONE;
  if (airWorse && dustUp && warmer) c = C_SMOKE;
  else if (gasAlarm && dD < 10.0f && fabsf(dT) < 1.0f) c = C_GAS;
  else if (gasAlarm && warmer) c = C_SMOKE;
  else if (dustUp && dA > -8.0f) c = C_DUST;
  else if (airWorse && !dustUp && fabsf(dT) < 1.0f) c = C_STUFFY;
  if (c != causeId) {
    if (c != lastCauseId || now - causeSince > 60000UL) causeSince = now;
    causeId = c;
    if (c) Serial.printf("[diagnose] %s (dust %+.0f, air %+.0f, temp %+.1f over the last minute)\n", causeWord(), dD, dA, dT);
  }
  if ((c == C_DUST || c == C_STUFFY) && (causeClipAt[c] == 0 || now - causeClipAt[c] >= 180000UL)) {
    causeClipAt[c] = now;
    queueClip(c == C_DUST ? CLIP_DUST_ONLY : CLIP_STUFFY, 90, now);
  }
  if (c == C_SMOKE && (causeSoundAt == 0 || now - causeSoundAt >= 60000UL)) {
    causeSoundAt = now; uploadNow = true;
    if (!speaking && sirenRequest == 0) sirenRequest = 1;
  }
  if (c) lastCauseId = c;
}

void connectionVoiceStep(uint32_t now) {          // called every 5 s: speaks Wi-Fi and sensor problems from the pod itself
  static bool wasOnline = false, lostSpoken = false, setupSpoken = false, faultSpoken = false;
  static uint32_t offSince = 0, faultSince = 0;
  bool online = netState >= 1;
  if (online) {
    if (lostSpoken) { queueClip(CLIP_BACK_ONLINE, 60, now); }
    wasOnline = true; lostSpoken = false; setupSpoken = false; offSince = 0;
  } else if (wasOnline) {
    if (!offSince) offSince = now ? now : 1;
    if (!lostSpoken && now - offSince >= 30000UL) { lostSpoken = true; queueClip(CLIP_WIFI_LOST, 70, now); }
    if (!setupSpoken && apActive && now - offSince >= 45000UL) { setupSpoken = true; queueClip(CLIP_WIFI_SETUP, 65, now); }
  }
  if (dhtTried && dhtFailed) {
    if (!faultSince) faultSince = now ? now : 1;
    if (!faultSpoken && now - faultSince >= 60000UL) { faultSpoken = true; queueClip(CLIP_SENSOR_FAULT, 75, now); }
  } else { faultSince = 0; faultSpoken = false; }
}

const char* causeAdvice() {
  switch (causeId) {
    case C_SMOKE:  return "Smoke or burning likely: heat and dust are up and the air is worse. Check for fire, open the windows, leave if unsafe.";
    case C_GAS:    return "Possible gas or fumes: air quality fell fast with no heat or dust. Open windows, put out flames, leave if you smell gas.";
    case C_DUST:   return "Dust is up but the air is otherwise fine. Likely dust, sweeping or ash. Open a window or use the fan.";
    case C_STUFFY: return "Air is getting stuffy with no heat or dust. Likely poor ventilation or CO2 or fumes building up. Open windows.";
    default: return nullptr;
  }
}

void predictStep() {
  for (int m = 0; m < 4; m++) {
    slopeMin[m] = 0; predMin[m] = -1;
    int n = histN[m];
    if (n < 12) continue;
    int k = n < 24 ? n : 24;
    const float* h = hist[m] + (n - k);
    float sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (int i = 0; i < k; i++) { sx += i; sy += h[i]; sxx += (float)i * i; sxy += i * h[i]; }
    float den = k * sxx - sx * sx;
    if (den <= 0) continue;
    float slope = (k * sxy - sx * sy) / den;           // per 5 s sample
    slopeMin[m] = slope * 12.0f;
    if (locStatus[m] != ST_OK) continue;
    if (fabsf(slopeMin[m] * 2.0f) < LIM[m].hyst) continue;   // too small to be real
    float cur = h[k - 1], lim = NAN;
    if (slope > 0 && !isnan(LIM[m].wH)) lim = LIM[m].wH;
    if (slope < 0 && !isnan(LIM[m].wL)) lim = LIM[m].wL;
    if (isnan(lim)) continue;
    float t = (lim - cur) / slopeMin[m];
    if (t > 0 && t <= 15) predMin[m] = (int)ceilf(t);
  }
}

void setAdvice(const char* t, uint8_t lvl) {
  if (adviceLevel == lvl && strcmp(adviceText, t) == 0) return;
  strlcpy(adviceText, t, sizeof(adviceText));
  adviceLevel = lvl;
  adviceAt = millis();
}

const char* adviceFor(int m, uint8_t st) {
  switch (m) {
    case 0: return st == ST_BAD_H ? "Dust is very high. Open the windows and turn on the fan now." : "Dust is rising. Open a window or turn on the fan.";
    case 1: return st == ST_BAD_L ? "Air quality is poor. Open the windows and turn on the fan." : "Air quality is fair. Open a window to freshen the air.";
    case 2: if (st == ST_BAD_H) return "It is too hot. Turn on the AC and open a window.";
            if (st == ST_WATCH_H) return "It is getting warm. Turn on the fan or AC.";
            return "It is cold. Close the windows.";
    default: if (st == ST_BAD_H) return "Humidity is very high. Turn on the AC or fan and open a window.";
             if (st == ST_WATCH_H) return "Humidity is high. Turn on the fan or AC.";
             return "The air is dry. A humidifier or a bowl of water can help.";
  }
}

void refreshAdvice(uint32_t now) {
  if (causeId == C_SMOKE || causeId == C_GAS) { setAdvice(causeAdvice(), 2); return; }
  if (gasAlarm) { setAdvice("Possible gas or fumes. Open the windows, put out any flame and leave the room if you smell gas.", 2); return; }
  if (causeId == C_DUST || causeId == C_STUFFY) { if (locStatus[0] != ST_OK || locStatus[1] != ST_OK || causeId == C_DUST) { setAdvice(causeAdvice(), 1); return; } }
  int bestM = -1, bestSev = 0;
  for (int m = 0; m < 4; m++) { int sv = sevOf(locStatus[m]); if (sv > bestSev) { bestSev = sv; bestM = m; } }
  if (bestM >= 0) { setAdvice(adviceFor(bestM, locStatus[bestM]), bestSev == 2 ? 2 : 1); return; }
  if (rapidMsg && now - rapidMsgAt < 300000) { setAdvice(rapidMsg, 1); return; }
  static const char* NAMES[4] = { "Dust", "Air quality", "Temperature", "Humidity" };
  int pm = -1, bestT = 99;
  for (int m = 0; m < 4; m++) if (predMin[m] > 0 && predMin[m] < bestT) { bestT = predMin[m]; pm = m; }
  if (pm >= 0) {
    char b[112];
    snprintf(b, sizeof(b), "%s is %s and may leave the healthy range in about %d min.", NAMES[pm], slopeMin[pm] > 0 ? "rising" : "falling", bestT);
    setAdvice(b, 3);
    return;
  }
  if (!mqReady) { setAdvice("Air sensor is warming up. Air readings are still settling.", 0); return; }
  setAdvice("All readings are within healthy limits.", 0);
}

static uint32_t gasCooldownUntil = 0;
void gasStep(uint32_t now, float air) {
  if (isnan(air)) return;
  bool test = gasTestUntil && (int32_t)(gasTestUntil - now) > 0;
  if (isnan(airRef)) { airRef = air; gasWarmAt = now; }
  if (!test && now - gasWarmAt < 20000) { airRef += 0.2f * (air - airRef); return; }   // let the sensor settle after warm-up

  // Do not re-trigger during cooldown to prevent sensor bounce / double trigger
  if (!gasAlarm && !test && (int32_t)(gasCooldownUntil - now) > 0) return;

  bool bad = test || air < GAS_LOW_LEVEL || air <= airRef - GAS_DROP_POINTS;
  if (!gasAlarm) {
    if (bad) {
      if (!gasLowSince) gasLowSince = now ? now : 1;
      // Require 2.5s sustained drop before alarm latch (filters out transient ADC spikes)
      if (now - gasLowSince >= (test ? 0 : 2500)) {
        gasAlarm = true; gasStarted = now; gasLastSound = 0; gasClearSince = 0; gasTrig = true; uploadNow = true;
        Serial.printf("[ALARM] possible gas or fumes: air index %.0f (baseline %.0f)\n", air, airRef);
      }
    } else {
      gasLowSince = 0;
      airRef += 0.01f * (air - airRef);          // follow slow changes only
    }
  } else {
    // Hold alarm for at least 15s to prevent stutter/double-buzzing
    bool minHoldPassed = (now - gasStarted) >= 15000UL;
    bool ok = !test && minHoldPassed && air >= GAS_LOW_LEVEL + 8 && air >= airRef - 6.0f;
    if (ok) { if (!gasClearSince) gasClearSince = now ? now : 1; } else gasClearSince = 0;
    bool timeout = now - gasStarted > 300000UL;  // never stay in alarm forever if the room really changed
    if ((gasClearSince && now - gasClearSince >= 12000) || timeout) {
      gasAlarm = false; gasLowSince = 0; uploadNow = true;
      gasCooldownUntil = now + 15000UL; // 15-second debounce cooldown
      if (timeout) airRef = air;
      Serial.println("[ALARM] cleared");
      queueClip(CLIP_ALL_GOOD, 90, now);
    }
  }
}

void drawSosScreen(uint32_t now) {
  static int lastPhase = -1;
  int phase = (now / 350) & 1;
  if (phase == lastPhase) return;
  lastPhase = phase;
  tft.fillScreen(phase ? 0xF800 : 0x0000);  // flashing Red and Black
  tft.setTextColor(ST77XX_WHITE);
  tft.setTextSize(3);
  tft.setCursor(55, 14);  tft.print("SOS");
  tft.setTextSize(1);
  tft.setCursor(20, 50);  tft.print("EMERGENCY ALARM");
  tft.setCursor(14, 68);  tft.print("Triggered from EcoVital app");
  tft.setCursor(18, 90);  tft.print("Check room and occupants");
  tft.setCursor(24, 110); tft.print("Press BOOT to clear");
}

void drawGasScreen(uint32_t now) {
  static int lastPhase = -1;
  int phase = (now / 400) & 1;
  if (phase == lastPhase) return;
  lastPhase = phase;
  tft.fillScreen(phase ? 0xF800 : 0x8000);
  tft.setTextColor(ST77XX_WHITE);
  tft.setTextSize(2);
  tft.setCursor(22, 8);   tft.print("WARNING");
  tft.setTextSize(1);
  tft.setCursor(20, 34);  tft.print("Possible gas or fumes");
  tft.setCursor(20, 54);  tft.print("1. Open the windows");
  tft.setCursor(20, 68);  tft.print("2. Put out any flame");
  tft.setCursor(20, 82);  tft.print("3. Leave if you smell gas");
  tft.setCursor(20, 106); tft.printf("Air index %d%%", (int)(isnan(curAir) ? 0 : curAir));
}

void servicePending(uint32_t now) {             // called every loop
  if (pendingClip < 0 || speaking || clipRequest >= 0) return;
  bool online = (netState == 2) && (now - lastOkMs < 40000);
  if (lastCloudSpeakMs > pendingAt) { pendingClip = -1; return; }       // the AI already spoke
  if (!online || now - pendingAt >= 35000) {
    Serial.printf("[alert] speaking offline advice (clip %d)\n", pendingClip);
    clipRequest = pendingClip;
    pendingClip = -1;
  }
}

static inline int16_t ulaw2lin(uint8_t u) {
  u = ~u;
  int t = ((u & 0x0F) << 3) + 0x84;
  t <<= ((unsigned)u & 0x70) >> 4;
  return (u & 0x80) ? (0x84 - t) : (t - 0x84);
}

static const int16_t ADPCM_STEP[89] PROGMEM = {7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767};
static const int8_t ADPCM_IDX[8] = {-1, -1, -1, -1, 2, 4, 6, 8};
static inline int16_t adpcmNext(int& pred, int& idx, uint8_t code) {   // 4-bit IMA ADPCM -> one 16-bit sample
  int step = (int16_t)pgm_read_word(ADPCM_STEP + idx);
  int d = step >> 3;
  if (code & 4) d += step;
  if (code & 2) d += step >> 1;
  if (code & 1) d += step >> 2;
  pred += (code & 8) ? -d : d;
  if (pred > 32767) pred = 32767; else if (pred < -32768) pred = -32768;
  idx += ADPCM_IDX[code & 7];
  if (idx < 0) idx = 0; else if (idx > 88) idx = 88;
  return (int16_t)pred;
}

void playClip(int id) {
  if (id < 0 || id >= CLIP_COUNT) return;
  if (!i2sStart()) { Serial.println("[audio] I2S start failed"); return; }
  speaking = true;
  int16_t z[256 * 2] = {0};
  i2sWrite(z, sizeof(z));
  const uint8_t* d = CLIPS[id].d;
  uint32_t n = CLIPS[id].n;
  int16_t frames[512 * 2];
  int fi = 0;
  int apred = 0, aidx = 0;
  int16_t a = n ? adpcmNext(apred, aidx, pgm_read_byte(d) & 15) : 0;
  for (uint32_t i = 0; i < n; i++) {
    int16_t b = a;
    if (i + 1 < n) { uint32_t j = i + 1; uint8_t by = pgm_read_byte(d + (j >> 1)); b = adpcmNext(apred, aidx, (j & 1) ? (by >> 4) : (by & 15)); }
    int16_t o[2] = { a, (int16_t)(((int32_t)a + b) / 2) };     // 12 kHz -> 24 kHz: each sample plus the midpoint
    a = b;
    for (int k = 0; k < 2; k++) {
      int32_t v = (int32_t)(o[k] * CLIP_VOLUME);
      if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
      frames[fi++] = (int16_t)v; frames[fi++] = (int16_t)v;
    }
    if (fi >= 512 * 2) { i2sWrite(frames, fi * 2); fi = 0; }
  }
  if (fi) i2sWrite(frames, fi * 2);
  i2sWrite(z, sizeof(z));
  speaking = false;
  i2sStop();
}

void serviceAudio() {                           // runs on the network core, the only place that touches the speaker after boot
  if (sosRequest) { sosRequest = false; playSos(); }
  if (sirenRequest > 0) { sirenRequest = 0; playSiren(); playClip(causeId == C_SMOKE ? CLIP_SMOKE : CLIP_GAS); }
  if (clipRequest >= 0) { int c = clipRequest; clipRequest = -1; playClip(c); }
  if (beepRequest > 0)  { int c = beepRequest; beepRequest = 0; beepPattern(c); }
}

// ---------- PAIRING, SETUP PORTAL, LOCAL INFO, UPDATES (WLED style) ----------
#define PIN_BTN 0                         // the BOOT button on the dev board
WebServer webServer(80);
DNSServer dnsServer;
bool netServicesUp = false;
volatile bool otaBusy = false, otaPending = false;
volatile int otaPct = 0;
char otaUrlBuf[220] = "";
char otaVerBuf[24] = "";
uint32_t otaBackoffUntil = 0;
bool wasOta = false;
int otaDrawnPct = -1;
uint32_t infoUntil = 0, infoDrawnAt = 0, infoStripAt = 0;
volatile uint32_t lastClientMs = 0;
volatile bool calibrateReq = false;      // last time a phone/app/browser talked to the pod
bool bootInfo = false;                   // true while the start-up pairing screen is held
int infoSig = -1;

void loadIdentity() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  snprintf(macStr, sizeof(macStr), "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  snprintf(deviceId, sizeof(deviceId), "ecovital-%02x%02x%02x", mac[3], mac[4], mac[5]);
  snprintf(apName, sizeof(apName), "EcoVital-%02X%02X", mac[4], mac[5]);
  snprintf(deviceName, sizeof(deviceName), "EcoVital Pod %02X%02X", mac[4], mac[5]);
  { String nm = prefs.getString("name", ""); if (nm.length()) nm.toCharArray(deviceName, sizeof(deviceName)); }
  String c = prefs.getString("claim", "");
  if (c.length() != 6) {
    const char* A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    char b[7];
    for (int i = 0; i < 6; i++) b[i] = A[esp_random() % 32];
    b[6] = 0;
    c = String(b);
    prefs.putString("claim", c);
  }
  c.toCharArray(claimCode, sizeof(claimCode));
  bool wiped = prefs.getBool("wiped", false);
  cfgSsid = prefs.getString("ssid", wiped ? "" : DEFAULT_SSID);
  cfgPass = prefs.getString("pass", wiped ? "" : DEFAULT_PASS);
  cfgBase = prefs.getString("base", DEFAULT_BASE);
  cfgKey  = prefs.getString("key",  DEFAULT_KEY);
  cfgTok  = prefs.getString("tok",  "");
  // an older setup page could have saved the placeholder address or key: ignore those and use the built-in ones
  if (cfgBase.indexOf("your-app") >= 0 || !cfgBase.length()) { cfgBase = DEFAULT_BASE; prefs.remove("base"); }
  if (cfgKey.startsWith("the-same-") || !cfgKey.length()) { cfgKey = DEFAULT_KEY; prefs.remove("key"); }
  while (cfgBase.endsWith("/")) cfgBase.remove(cfgBase.length() - 1);
  if (cfgSsid == "YOUR_WIFI_NAME") { cfgSsid = DEFAULT_SSID; cfgPass = DEFAULT_PASS; }   // an old build saved the placeholder: use the built-in one
  spkVol = prefs.getUChar("vol", 100) / 100.0f;
  muted = prefs.getBool("muted", false);
}

void printPairing() {
  Serial.println("---- pairing info ----");
  Serial.printf("device id : %s\n", deviceId);
  Serial.printf("name      : %s\n", deviceName);
  Serial.printf("MAC       : %s\n", macStr);
  Serial.printf("pair code : %s\n", claimCode);
  Serial.printf("Wi-Fi     : %s (%s)\n", cfgSsid.length() ? cfgSsid.c_str() : "not set",
                WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString().c_str() : "not connected");
  if (apActive) Serial.printf("setup net : join Wi-Fi \"%s\" then open http://192.168.4.1/\n", apName);
  Serial.printf("cloud     : %s\n", cfgBase.length() ? cfgBase.c_str() : "not set");
  Serial.println("----------------------");
}

void forceRedraw() {
  tft.fillScreen(COL_BG);
  for (int i = 0; i < 4; i++) widgets[i]->lastAng = -1;
  lastHeaderState = -1;
  lastFooter = "";
}

void resetWifiAndRestart() {
  tft.fillScreen(COL_BG);
  tft.setTextSize(1);
  tft.setTextColor(COL_AMBER);
  tft.setCursor(14, 56);
  tft.print("Wi-Fi settings cleared");
  tft.setTextColor(COL_SUBTEXT);
  tft.setCursor(38, 72);
  tft.print("Restarting...");
  prefs.remove("ssid");
  prefs.remove("pass");
  prefs.putBool("wiped", true);
  delay(1200);
  ESP.restart();
}

String numStr(float v) { return isnan(v) ? String("null") : String(v, 1); }

String jsonInfo() {
  String s = "{\"id\":\"";
  s += deviceId; s += "\",\"name\":\""; s += deviceName;
  s += "\",\"mac\":\""; s += macStr;
  s += "\",\"fw\":\""; s += FW_VERSION;
  s += "\",\"claim\":\""; s += claimCode;
  s += "\",\"ip\":\""; s += WiFi.localIP().toString();
  s += "\",\"ssid\":\""; s += cfgSsid;
  s += "\",\"rssi\":"; s += String(WiFi.RSSI());
  s += ",\"uptimeS\":"; s += String(millis() / 1000);
  s += ",\"cloud\":"; s += (netState == 2 ? "true" : "false");
  s += ",\"muted\":"; s += (muted ? "true" : "false");
  s += ",\"volume\":"; s += String((int)(spkVol * 100 + 0.5f));
  s += ",\"readings\":{\"dust\":"; s += numStr(curDust);
  s += ",\"air\":"; s += numStr(mqReady ? curAir : NAN);
  s += ",\"temp\":"; s += numStr(dhtFailed ? NAN : curTemp);
  s += ",\"hum\":"; s += numStr(dhtFailed ? NAN : curHum);
  s += "},\"status\":["; s += String(locStatus[0]); s += ","; s += String(locStatus[1]); s += ","; s += String(locStatus[2]); s += ","; s += String(locStatus[3]);
  s += "]}";
  return s;
}

static const char POD_PAGE[] PROGMEM =
  "<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>EcoVital pod</title><style>\n"
  ":root{--paper:#edf1ea;--panel:#f6f8f3;--ink:#14211b;--ink2:#55665d;--rule:#c9d3c5;--good:#2b9a6f;--watch:#c98618;--bad:#cf4336;--fc:#4252cf;--bw:rgba(201,134,24,.14);--bb:rgba(207,67,54,.15);color-scheme:light dark}\n"
  "@media(prefers-color-scheme:dark){:root{--paper:#0e1512;--panel:#131c18;--ink:#e4ece6;--ink2:#94a79d;--rule:#26332c;--good:#46c391;--watch:#e8a93b;--bad:#f06b5d;--fc:#8d99ff;--bw:rgba(232,169,59,.13);--bb:rgba(240,107,93,.16)}}\n"
  "*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 \"Segoe UI Variable Text\",\"Segoe UI\",system-ui,sans-serif;font-variant-numeric:tabular-nums}\n"
  "button,input,select{font:inherit;color:inherit}.wrap{max-width:1000px;margin:0 auto;padding:0 16px 56px}\n"
  ".top{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;padding:20px 0 10px}.brand{font-size:18px;font-weight:650}.crumb,.sub{color:var(--ink2)}.sp{flex:1}\n"
  ".live{display:inline-flex;align-items:center;gap:8px;color:var(--ink2);font-size:13px}.dot{width:9px;height:9px;border-radius:50%;background:var(--ink2);flex:none}.dot.good{background:var(--good)}.dot.watch{background:var(--watch)}.dot.bad{background:var(--bad)}\n"
  ".tabs{display:flex;gap:6px;margin:4px 0 18px}.btn{border:1px solid var(--rule);background:transparent;padding:6px 13px;border-radius:6px;cursor:pointer}.btn:hover{background:var(--panel)}.btn.on{background:var(--ink);color:var(--paper);border-color:var(--ink)}.btn.p{background:var(--good);border-color:var(--good);color:#fff}.btn.d{border-color:var(--bad);color:var(--bad)}\n"
  ".said{border-left:4px solid var(--rule);padding:6px 0 6px 18px;margin:6px 0 24px;max-width:70ch}.said.l1{border-color:var(--watch)}.said.l2{border-color:var(--bad)}.said.l3{border-color:var(--fc)}.said q{display:block;quotes:none;font-size:23px;line-height:1.3;letter-spacing:-.01em}.said .m{margin-top:6px;color:var(--ink2);font-size:13px}\n"
  ".cols{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:30px;align-items:start}@media(max-width:860px){.cols{grid-template-columns:1fr}}\n"
  ".metric{padding:14px 0 16px;border-top:1px solid var(--rule)}.mh{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}.mh b{font-weight:600}.val{font-size:34px;font-weight:600;letter-spacing:-.02em;margin-left:auto}.val small{font-size:15px;font-weight:400;color:var(--ink2);margin-left:2px}\n"
  ".pill{font-size:12px;padding:1px 9px;border-radius:99px;border:1px solid currentColor}.pill.good{color:var(--good)}.pill.watch{color:var(--watch)}.pill.bad{color:var(--bad)}\n"
  "canvas{width:100%;height:76px;display:block;margin-top:6px}.note{color:var(--ink2);font-size:13px}.note.f{color:var(--fc)}\n"
  ".side h3,.set h3{font-size:13px;font-weight:600;color:var(--ink2);margin:0 0 8px;letter-spacing:.02em}.kv{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px solid var(--rule)}.kv span:first-child{color:var(--ink2)}.kv span:last-child{text-align:right;word-break:break-all}\n"
  ".banner{background:var(--panel);border:1px solid var(--rule);border-left:4px solid var(--watch);padding:10px 14px;margin:0 0 16px;border-radius:4px}\n"
  ".set{max-width:560px}.set section{padding:16px 0;border-top:1px solid var(--rule)}label{display:block;color:var(--ink2);font-size:13px;margin:10px 0 3px}\n"
  "input[type=text],input[type=password],input[type=url],select{width:100%;padding:9px 10px;border:1px solid var(--rule);border-radius:6px;background:var(--panel)}input[type=range]{width:100%}\n"
  ".row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}.hint{color:var(--ink2);font-size:13px;margin:6px 0 0}.hide{display:none}\n"
  "</style></head><body><div class=wrap>\n"
  "<div class=top><span class=brand>EcoVital</span><span class=crumb id=nm>Pod</span><span class=sp></span><span class=live><i class=dot id=ld></i><span id=lt>Connecting...</span></span></div>\n"
  "<div class=tabs><button class=\"btn on\" id=t1>Live</button><button class=btn id=t2>Settings</button></div>\n"
  "<div id=off class=\"banner hide\">The pod is not answering. Check that it is powered and that this device is on the same Wi-Fi.</div>\n"
  "<div id=v1><div class=said id=sd><q id=sq>Reading the sensors...</q><div class=m id=sm></div></div>\n"
  "<div class=cols><div id=ms></div><div class=side><h3>This pod</h3><div id=kv></div></div></div></div>\n"
  "<div id=v2 class=\"set hide\">\n"
  "<section><h3>Wi-Fi</h3><label for=ssid>Network name</label><input type=text id=ssid autocomplete=off list=nets><datalist id=nets></datalist>\n"
  "<label for=pass>Password</label><input type=password id=pass autocomplete=off>\n"
  "<div class=row><button class=btn id=scan>Find networks</button><span class=hint id=sh></span></div></section>\n"
  "<section><h3>EcoVital app</h3><label for=base>App address</label><input type=url id=base placeholder=\"https://your-app.vercel.app\">\n"
  "<label for=key>Device key</label><input type=password id=key placeholder=\"Leave empty to keep the saved key\">\n"
  "<div class=row><button class=\"btn p\" id=sv>Save and restart pod</button></div><p class=hint>Saving Wi-Fi or app details restarts the pod. It keeps its pair code.</p></section>\n"
  "<section><h3>This pod</h3><label for=pn>Name</label><input type=text id=pn maxlength=31>\n"
  "<label for=vol>Speaker volume <span id=vv></span></label><input type=range id=vol min=0 max=100 step=5>\n"
  "<div class=row><label style=\"margin:0;display:flex;gap:8px;align-items:center\"><input type=checkbox id=mu> Mute voice alerts</label><button class=btn id=sn>Save name</button></div></section>\n"
  "<section><h3>Maintenance</h3><div class=row><button class=btn id=cal>Calibrate in clean air</button><button class=btn id=rs>Restart</button><button class=\"btn d\" id=fw>Forget Wi-Fi</button></div>\n"
  "<p class=hint>Calibrate only after the pod has run for 5 minutes in fresh air. Forget Wi-Fi puts the pod back in setup mode.</p></section>\n"
  "<section><h3>About</h3><div id=ab></div></section></div></div>\n"
  "<script>\n"
  "const $=s=>document.getElementById(s);let D=null,TR=null,fails=0,lastT=0,tab=1;\n"
  "const M=[{k:'air',i:1,n:'Air index',u:'%',d:0,r:[0,100],t:'Relative 0-100, higher is cleaner'},{k:'dust',i:0,n:'Dust',u:'%',d:0,r:[0,100],t:'Relative 0-100 dust index'},{k:'temp',i:2,n:'Temperature',u:'°C',d:1,r:[10,45],t:''},{k:'hum',i:3,n:'Humidity',u:'%',d:0,r:[0,100],t:''}];\n"
  "const W={air:['Clean','','','Fair','Poor'],dust:['Low','Dusty','Very dusty','',''],temp:['Comfortable','Warm','Hot','Cool','Cold'],hum:['Comfortable','Humid','Very humid','Dry','Very dry']};\n"
  "const lv=s=>s==0?'good':(s==1||s==3)?'watch':'bad';\n"
  "$('ms').innerHTML=M.map(m=>`<div class=metric><div class=mh><b>${m.n}</b><span class=\"pill good\" id=p_${m.k}>-</span><span class=val id=v_${m.k}>--</span></div><canvas id=c_${m.k} width=600 height=152></canvas><div class=note id=n_${m.k}>${m.t}</div></div>`).join('');\n"
  "function show(n){tab=n;$('v1').classList.toggle('hide',n!=1);$('v2').classList.toggle('hide',n!=2);$('t1').classList.toggle('on',n==1);$('t2').classList.toggle('on',n==2);if(n==2)fillSet(true)}\n"
  "$('t1').onclick=()=>show(1);$('t2').onclick=()=>show(2);\n"
  "function ago(s){return s<90?s+' s':s<5400?Math.round(s/60)+' min':Math.round(s/3600)+' h'}\n"
  "function css(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim()}\n"
  "function spark(m){const c=$('c_'+m.k),x=c.getContext('2d'),w=c.width=c.clientWidth*2,h=c.height=152;x.clearRect(0,0,w,h);if(!D)return;\n"
  "const [a,b]=m.r,Y=v=>h-4-(v-a)/(b-a)*(h-8),L=D.lim[m.i];\n"
  "const band=(lo,hi,col)=>{lo=Math.max(a,lo);hi=Math.min(b,hi);if(hi>lo){x.fillStyle=col;x.fillRect(0,Y(hi),w,Y(lo)-Y(hi))}};\n"
  "if(L[0]!=null)band(L[0],L[1]!=null?L[1]:b,css('--bw'));if(L[1]!=null)band(L[1],b,css('--bb'));\n"
  "if(L[2]!=null)band(L[3]!=null?L[3]:a,L[2],css('--bw'));if(L[3]!=null)band(a,L[3],css('--bb'));\n"
  "const d=TR?TR.d[m.i]:[];if(d.length<2)return;x.strokeStyle=css('--ink');x.lineWidth=3;x.lineJoin='round';x.beginPath();let on=false;\n"
  "d.forEach((v,j)=>{if(v==null){on=false;return}const px=j/(d.length-1)*w;if(!on){x.moveTo(px,Y(v));on=true}else x.lineTo(px,Y(v))});x.stroke()}\n"
  "function render(){if(!D)return;$('nm').textContent=D.name;document.title=D.name+' - EcoVital';\n"
  "const s=$('sd');s.className='said l'+D.adv.lv;$('sq').textContent=D.adv.t;$('sm').textContent=(D.adv.lv==3?'Early warning from the pod. ':'')+'Updated '+ago(D.adv.age)+' ago. Worked out on the pod, so it works without Wi-Fi.';\n"
  "M.forEach(m=>{const v=D.v[m.i],st=D.st[m.i];$('v_'+m.k).innerHTML=v==null?'--':v.toFixed(m.d)+'<small>'+m.u+'</small>';\n"
  "const p=$('p_'+m.k);if(v==null){p.className='pill';p.textContent=m.k=='air'&&!D.mq?'Warming up':'No reading'}else{p.className='pill '+lv(st);p.textContent=W[m.k][st]}\n"
  "let n=m.t;const sl=D.sl[m.i];if(D.pr[m.i]>0)n='May leave the healthy range in about '+D.pr[m.i]+' min';else if(v!=null&&Math.abs(sl)>=(m.k=='temp'?.3:2))n=(sl>0?'Rising':'Falling')+' about '+Math.abs(sl).toFixed(1)+' per minute';\n"
  "const e=$('n_'+m.k);e.textContent=n;e.className='note'+(D.pr[m.i]>0?' f':'');spark(m)});\n"
  "const on=D.wifi,k=[['Wi-Fi',on?D.ssid+' ('+D.rssi+' dBm)':(D.ap?'Setup mode':'Disconnected')],['Address',on?D.ip:'-'],['EcoVital app',D.cloud?'Online':'Offline'],\n"
  "['Saved on pod',D.backlog+' readings'+(D.backlog&&!D.cloud?' (sent when back online)':'')],['Air sensor',D.mq?'Ready':'Warming up '+D.warm+'%'],['Clock',D.t?new Date(D.t*1000).toLocaleTimeString():'Not synced'],['Up for',ago(D.up)],['Firmware',D.fw]];\n"
  "$('kv').innerHTML=k.map(r=>`<div class=kv><span>${r[0]}</span><span>${r[1]}</span></div>`).join('');\n"
  "$('ld').className='dot '+(D.cloud?'good':on?'watch':'bad');$('lt').textContent=D.cloud?'Live, app online':on?'Live, app offline':'Live, no Wi-Fi'}\n"
  "async function poll(){try{const wt=(!TR||Date.now()-lastT>10000)?1:0;const r=await fetch('/api/live'+(wt?'?trend=1':''),{cache:'no-store'});D=await r.json();if(wt){TR=D.trend;lastT=Date.now()}fails=0;$('off').classList.add('hide');render()}\n"
  "catch(e){if(++fails>=3){$('off').classList.remove('hide');$('ld').className='dot bad';$('lt').textContent='Not answering'}}}\n"
  "let filled=false;function fillSet(f){if(!D)return;if(f&&filled)return;filled=true;$('ssid').value=D.ssid||'';$('base').value=D.base||'';$('pn').value=D.name;$('vol').value=D.vol;$('vv').textContent=D.vol+'%';$('mu').checked=D.mute;\n"
  "$('ab').innerHTML=[['Pair code',D.claim],['Device ID',D.id],['MAC',D.mac],['Firmware',D.fw]].map(r=>`<div class=kv><span>${r[0]}</span><span>${r[1]}</span></div>`).join('')}\n"
  "const post=(u,o)=>fetch(u,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(o)});\n"
  "$('vol').oninput=()=>$('vv').textContent=$('vol').value+'%';$('vol').onchange=()=>post('/api/settings',{volume:$('vol').value});$('mu').onchange=()=>post('/api/settings',{muted:$('mu').checked?1:0});\n"
  "$('sn').onclick=async()=>{await post('/api/settings',{name:$('pn').value});D.name=$('pn').value;render()};\n"
  "$('sv').onclick=async()=>{await post('/save',{json:1,ssid:$('ssid').value,pass:$('pass').value,base:$('base').value,key:$('key').value,name:$('pn').value});document.body.innerHTML='<div class=wrap><p class=said><q>Saved. The pod is restarting.</q></p><p class=hint>Give it about 20 seconds, then open the pod again from your Wi-Fi.</p></div>'};\n"
  "$('cal').onclick=async()=>{if(confirm('Is the pod in fresh air and has it been on for 5 minutes?')){await post('/api/calibrate',{});$('sh').textContent='Calibrating...'}};\n"
  "$('rs').onclick=async()=>{await post('/api/restart',{});document.body.innerHTML='<div class=wrap><p class=said><q>Restarting.</q></p></div>'};\n"
  "$('fw').onclick=async()=>{if(confirm('Forget the saved Wi-Fi and restart in setup mode?')){await post('/reset',{});document.body.innerHTML='<div class=wrap><p class=said><q>Wi-Fi cleared. Join the EcoVital Wi-Fi to set the pod up again.</q></p></div>'}};\n"
  "async function scan(){$('sh').textContent='Looking for networks...';try{const r=await(await fetch('/api/scan',{cache:'no-store'})).json();if(r.scanning){setTimeout(scan,1500);return}\n"
  "$('nets').innerHTML=r.list.map(n=>`<option value=\"${n.ssid.replace(/\"/g,'&quot;')}\">${n.rssi} dBm</option>`).join('');$('sh').textContent=r.list.length+' networks found. Tap the name field to choose one.'}catch(e){$('sh').textContent='Scan failed. Type the name instead.'}}\n"
  "$('scan').onclick=scan;poll();setInterval(poll,2000);\n"
  "</script></div></body></html>\n"
  "\n";

String jq(const String& in) {                       // escape for JSON
  String o; o.reserve(in.length() + 4);
  for (size_t i = 0; i < in.length(); i++) {
    char c = in[i];
    if (c == '"' || c == '\\') { o += '\\'; o += c; }
    else if ((uint8_t)c >= 32) o += c;
  }
  return o;
}

String buildLive(bool withTrend) {
  bool on = WiFi.status() == WL_CONNECTED;
  time_t tn = time(nullptr);
  String s; s.reserve(withTrend ? 6800 : 1800);
  s += "{\"id\":\""; s += deviceId; s += "\",\"name\":\""; s += jq(String(deviceName));
  s += "\",\"mac\":\""; s += macStr; s += "\",\"fw\":\""; s += FW_VERSION;
  s += "\",\"claim\":\""; s += claimCode;
  s += "\",\"ssid\":\""; s += jq(cfgSsid); s += "\",\"base\":\""; s += jq(cfgBase);
  s += "\",\"wifi\":"; s += on ? "true" : "false";
  s += ",\"ap\":"; s += apActive ? "true" : "false";
  s += ",\"rssi\":"; s += on ? String(WiFi.RSSI()) : String(0);
  s += ",\"ip\":\""; s += on ? WiFi.localIP().toString() : String("");
  s += "\",\"cloud\":"; s += (netState == 2 ? "true" : "false");
  s += ",\"backlog\":"; s += String(ringCount());
  s += ",\"mq\":"; s += mqReady ? "true" : "false";
  s += ",\"warm\":"; s += String(mqReady ? 100 : (int)constrain((int)(millis() * 100UL / MQ_WARMUP_MS), 0, 99));
  s += ",\"t\":"; s += String((tn > 1700000000L) ? (long)tn : 0L);
  s += ",\"up\":"; s += String((unsigned long)(millis() / 1000));
  s += ",\"vol\":"; s += String((int)(spkVol * 100 + 0.5f));
  s += ",\"mute\":"; s += muted ? "true" : "false";
  s += ",\"v\":["; s += numStr(curDust); s += ","; s += numStr(mqReady ? curAir : NAN); s += ","; s += numStr(dhtFailed ? NAN : curTemp); s += ","; s += numStr(dhtFailed ? NAN : curHum);
  s += "],\"st\":["; for (int m = 0; m < 4; m++) { if (m) s += ","; s += String(locStatus[m]); }
  s += "],\"sl\":["; for (int m = 0; m < 4; m++) { if (m) s += ","; s += String(slopeMin[m], 2); }
  s += "],\"pr\":["; for (int m = 0; m < 4; m++) { if (m) s += ","; s += String(predMin[m]); }
  s += "],\"lim\":[";
  for (int m = 0; m < 4; m++) {
    if (m) s += ",";
    s += "["; s += numStr(LIM[m].wH); s += ","; s += numStr(LIM[m].bH); s += ","; s += numStr(LIM[m].wL); s += ","; s += numStr(LIM[m].bL); s += "]";
  }
  s += "],\"adv\":{\"t\":\""; s += jq(String(adviceText)); s += "\",\"lv\":"; s += String(adviceLevel);
  s += ",\"age\":"; s += String((unsigned long)((millis() - adviceAt) / 1000)); s += "}";
  if (withTrend) {
    s += ",\"trend\":{\"step\":20,\"d\":[";
    int start = (trendNext - trendFilled + TREND_N) % TREND_N;
    for (int m = 0; m < 4; m++) {
      if (m) s += ",";
      s += "[";
      for (int i = 0; i < trendFilled; i++) { if (i) s += ","; s += numStr(trendV[m][(start + i) % TREND_N]); }
      s += "]";
    }
    s += "]}";
  }
  s += "}";
  return s;
}

void handleRoot() {
  lastClientMs = millis() | 1;
  webServer.sendHeader("Cache-Control", "no-cache");
  webServer.send_P(200, "text/html", POD_PAGE);
}

void handleScan() {
  int n = WiFi.scanComplete();
  if (n == WIFI_SCAN_FAILED) { WiFi.scanNetworks(true); webServer.send(200, "application/json", "{\"scanning\":true,\"list\":[]}"); return; }
  if (n == WIFI_SCAN_RUNNING) { webServer.send(200, "application/json", "{\"scanning\":true,\"list\":[]}"); return; }
  String s = "{\"scanning\":false,\"list\":[";
  int shown = 0;
  for (int i = 0; i < n && shown < 16; i++) {
    String name = WiFi.SSID(i);
    if (!name.length()) continue;
    if (shown) s += ",";
    s += "{\"ssid\":\""; s += jq(name); s += "\",\"rssi\":"; s += String(WiFi.RSSI(i)); s += "}";
    shown++;
  }
  s += "]}";
  WiFi.scanDelete();
  webServer.send(200, "application/json", s);
}

void handleSettings() {                               // changes that do not need a restart
  if (webServer.hasArg("volume")) {
    int v = constrain(webServer.arg("volume").toInt(), 0, 100);
    spkVol = v / 100.0f; prefs.putUChar("vol", (uint8_t)v);
  }
  if (webServer.hasArg("muted")) { muted = webServer.arg("muted").toInt() != 0; prefs.putBool("muted", muted); }
  if (webServer.hasArg("name")) {
    String n = webServer.arg("name"); n.trim();
    if (n.length()) { n.substring(0, 31).toCharArray(deviceName, sizeof(deviceName)); prefs.putString("name", String(deviceName)); }
  }
  if (!muted && webServer.hasArg("volume")) beepRequest = 1;
  webServer.sendHeader("Access-Control-Allow-Origin", "*");
  webServer.send(200, "application/json", "{\"ok\":true}");
}

void handleSave() {
  if (webServer.arg("ssid").length()) {
    prefs.putString("ssid", webServer.arg("ssid"));
    prefs.putString("pass", webServer.arg("pass"));
    prefs.putBool("wiped", false);
  }
  if (webServer.arg("base").length()) prefs.putString("base", webServer.arg("base"));
  if (webServer.arg("key").length())  prefs.putString("key",  webServer.arg("key"));
  if (webServer.arg("name").length()) prefs.putString("name", webServer.arg("name").substring(0, 31));
  if (webServer.hasArg("json")) { webServer.send(200, "application/json", "{\"ok\":true}"); delay(900); ESP.restart(); }
  webServer.send(200, "text/html", "<meta name=viewport content='width=device-width,initial-scale=1'><body style='font-family:sans-serif;background:#0d2136;color:#e2eefa;padding:24px'><h2>Saved</h2><p>The pod is restarting and will join your Wi-Fi.</p>");
  delay(900);
  ESP.restart();
}

void handleReset() {
  webServer.send(200, "text/html", "<body style='font-family:sans-serif;background:#0d2136;color:#e2eefa;padding:24px'><h2>Wi-Fi cleared</h2><p>The pod is restarting in setup mode.</p>");
  delay(600);
  resetWifiAndRestart();
}

void startWebServer() {
  webServer.on("/", HTTP_GET, handleRoot);
  webServer.on("/api/info", HTTP_GET, []() {
    lastClientMs = millis() | 1;
    webServer.sendHeader("Access-Control-Allow-Origin", "*");
    webServer.send(200, "application/json", jsonInfo());
  });
  webServer.on("/api/live", HTTP_GET, []() {
    lastClientMs = millis() | 1;
    webServer.sendHeader("Access-Control-Allow-Origin", "*");
    webServer.sendHeader("Cache-Control", "no-store");
    webServer.send(200, "application/json", buildLive(webServer.hasArg("trend")));
  });
  webServer.on("/api/scan", HTTP_GET, handleScan);
  webServer.on("/api/settings", HTTP_POST, handleSettings);
  webServer.on("/api/calibrate", HTTP_POST, []() { calibrateReq = true; webServer.send(200, "application/json", "{\"ok\":true}"); });
  webServer.on("/api/restart", HTTP_POST, []() { webServer.send(200, "application/json", "{\"ok\":true}"); delay(500); ESP.restart(); });
  webServer.on("/save", HTTP_POST, handleSave);
  webServer.on("/reset", HTTP_POST, handleReset);
  webServer.onNotFound([]() {
    if (apActive) { webServer.sendHeader("Location", "http://192.168.4.1/", true); webServer.send(302, "text/plain", ""); }
    else webServer.send(404, "text/plain", "Not found");
  });
  webServer.begin();
}

void startPortal() {                       // pod's own Wi-Fi so you can give it your Wi-Fi details
  if (apActive) return;
  Serial.println("[portal] 1/3 stopping the Wi-Fi search"); Serial.flush();
  WiFi.setAutoReconnect(false);            // do not let the failed search fight the mode change (this was resetting the chip)
  WiFi.disconnect(false, false);
  delay(300);
  Serial.println("[portal] 2/3 starting the setup network"); Serial.flush();
  WiFi.mode(WIFI_AP_STA);
  delay(150);
  bool ok = WiFi.softAP(apName);
  Serial.printf("[portal] 3/3 setup network %s\n", ok ? "ready" : "FAILED"); Serial.flush();
  delay(150);
  dnsServer.start(53, "*", WiFi.softAPIP());
  WiFi.setAutoReconnect(true);
  apActive = true;
  apOpenedAt = millis();
  Serial.printf("[setup] join Wi-Fi \"%s\" then open http://192.168.4.1/\n", apName);
}

void onWifiUp() {                          // runs on the network core whenever Wi-Fi is connected
  if (apActive) { apActive = false; dnsServer.stop(); WiFi.softAPdisconnect(true); WiFi.mode(WIFI_STA); }
  if (netServicesUp) return;
  netServicesUp = true;
  configTime(0, 0, "pool.ntp.org", "time.google.com");     // real clock for the pod's web page
  ArduinoOTA.setHostname(deviceId);
  ArduinoOTA.setPassword(claimCode);
  ArduinoOTA.onStart([]() { otaBusy = true; otaPct = 0; });
  ArduinoOTA.onProgress([](unsigned int c, unsigned int t) { otaPct = t ? (int)(c * 100UL / t) : 0; });
  ArduinoOTA.onEnd([]() { otaPct = 100; });
  ArduinoOTA.onError([](ota_error_t e) { otaBusy = false; });
  ArduinoOTA.begin();                      // also starts mDNS: http://<deviceId>.local
  MDNS.addService("ecovital", "tcp", 80);
  MDNS.addServiceTxt(String("ecovital"), String("tcp"), String("id"), String(deviceId));
  MDNS.addServiceTxt(String("ecovital"), String("tcp"), String("fw"), String(FW_VERSION));
  MDNS.addServiceTxt(String("ecovital"), String("tcp"), String("mac"), String(macStr));
  Serial.printf("[net] discoverable as %s.local (service _ecovital._tcp), pair code %s\n", deviceId, claimCode);
}

void portalTick() {
  webServer.handleClient();
  if (apActive) dnsServer.processNextRequest();
  if (netServicesUp) ArduinoOTA.handle();
}

// Extra instructions the web app can put in its reply to an upload (all optional):
//   "volume":0-100  "mute":true|false  "otaVersion":"1.2","otaUrl":"https://.../firmware.bin"
bool jsonStr(const String& r, const char* key, char* out, size_t cap) {
  String k = String("\"") + key + "\":\"";
  int i = r.indexOf(k);
  if (i < 0) return false;
  i += k.length();
  int j = r.indexOf('"', i);
  if (j < 0 || (size_t)(j - i) >= cap) return false;
  r.substring(i, j).toCharArray(out, cap);
  return true;
}

void handleExtras(const String& r) {
  int i = r.indexOf("\"volume\":");
  if (i >= 0) {
    int v = constrain(atoi(r.c_str() + i + 9), 0, 100);
    if (v != (int)(spkVol * 100 + 0.5f)) { spkVol = v / 100.0f; prefs.putUChar("vol", (uint8_t)v); }
  }
  bool m = r.indexOf("\"mute\":true") >= 0;
  if (r.indexOf("\"mute\":") >= 0 && m != muted) { muted = m; prefs.putBool("muted", m); }
  if (r.indexOf("\"cmd\":\"identify\"") >= 0) { beepRequest = 3; infoUntil = millis() + 15000; infoDrawnAt = 0; Serial.println("[cmd] find this pod"); }
  else if (r.indexOf("\"cmd\":\"calibrate\"") >= 0) { calibrateReq = true; beepRequest = 1; Serial.println("[cmd] recalibrate"); }
  else if (r.indexOf("\"cmd\":\"restart\"") >= 0) { restartReq = true; Serial.println("[cmd] restart"); }
  if (r.indexOf("\"sos\":true") >= 0) { sosRequest = true; sosActive = true; sosStarted = millis(); Serial.println("[sos] alarm requested from the app"); }
  char nm[40];
  if (jsonStr(r, "name", nm, sizeof(nm)) && nm[0] && strcmp(nm, deviceName) != 0) {
    strlcpy(deviceName, nm, sizeof(deviceName)); prefs.putString("name", String(deviceName));
  }
  int li = r.indexOf("\"lim\":[");
  if (li >= 0) {
    const char* p = r.c_str() + li + 7;
    float v[16]; int got = 0;
    while (got < 16 && *p && *p != ']') {
      while (*p == ' ' || *p == ',') p++;
      if (strncmp(p, "null", 4) == 0) { v[got++] = NAN; p += 4; }
      else { char* e; float f = strtof(p, &e); if (e == p) break; v[got++] = f; p = e; }
    }
    if (got == 16) for (int m = 0; m < 4; m++) { LIM[m].wH = v[m * 4]; LIM[m].bH = v[m * 4 + 1]; LIM[m].wL = v[m * 4 + 2]; LIM[m].bL = v[m * 4 + 3]; }
  }
  char ver[24], url[220];
  char tok[64];
  if (jsonStr(r, "deviceToken", tok, sizeof(tok)) && strlen(tok) >= 12 && cfgTok != tok) {   // the cloud gave this pod its own private key
    cfgTok = tok; prefs.putString("tok", cfgTok);
    Serial.println("[net] received this pod's private cloud token");
  }
  if (jsonStr(r, "otaVersion", ver, sizeof(ver)) && jsonStr(r, "otaUrl", url, sizeof(url))) {
    // skip if we already installed this version (a mismatched version name must not cause an update loop) or a try just failed
    bool tried = prefs.getString("otaTry", "") == String(ver);
    if (strcmp(ver, FW_VERSION) != 0 && strncmp(url, "http", 4) == 0 && !tried && (int32_t)(millis() - otaBackoffUntil) >= 0) {
      strlcpy(otaUrlBuf, url, sizeof(otaUrlBuf)); strlcpy(otaVerBuf, ver, sizeof(otaVerBuf)); otaPending = true;
    }
  }
}

void runOta() {
  prefs.putString("otaTry", otaVerBuf);
  Serial.printf("[ota] updating from %s\n", otaUrlBuf);
  otaBusy = true; otaPct = 0;
  WiFiClientSecure sec;
  WiFiClient plain;
  httpUpdate.rebootOnUpdate(false);
  httpUpdate.setFollowRedirects(HTTPC_FORCE_FOLLOW_REDIRECTS);
  httpUpdate.onProgress([](int cur, int total) { otaPct = total ? (int)((int64_t)cur * 100 / total) : 0; });
  t_httpUpdate_return r;
  if (strncmp(otaUrlBuf, "https", 5) == 0) { sec.setInsecure(); r = httpUpdate.update(sec, String(otaUrlBuf)); }
  else r = httpUpdate.update(plain, String(otaUrlBuf));
  if (r == HTTP_UPDATE_OK) { otaPct = 100; delay(600); ESP.restart(); }
  Serial.printf("[ota] failed: %s\n", httpUpdate.getLastErrorString().c_str());
  prefs.remove("otaTry");
  otaBackoffUntil = millis() + 300000UL;   // try again in 5 minutes
  otaBusy = false;
}

void drawOtaScreen() {
  if (otaDrawnPct < 0) {
    tft.fillScreen(COL_BG);
    tft.setTextSize(1);
    tft.setTextColor(ST77XX_WHITE);
    tft.setCursor(34, 46);
    tft.print("Updating firmware");
    tft.setTextColor(COL_SUBTEXT);
    tft.setCursor(26, 62);
    tft.print("Do not unplug the pod");
    tft.drawRoundRect(19, 84, 122, 10, 4, COL_CARD_EDGE);
  }
  if (otaPct != otaDrawnPct) {
    otaDrawnPct = otaPct;
    tft.fillRect(20, 85, 120, 8, COL_BG);
    tft.fillRect(20, 85, constrain(otaPct, 0, 100) * 120 / 100, 8, COL_MINT);
  }
}

extern bool mqReady;
void infoStrip() {            // bottom line: air sensor warm-up bar, then the BOOT hint
  tft.fillRect(0, 108, 160, 20, COL_BG);
  tft.setTextSize(1);
  if (!mqReady) {
    int pct = constrain((int)(millis() * 100UL / MQ_WARMUP_MS), 0, 99);
    tft.setTextColor(COL_AMBER);
    tft.setCursor(6, 108); tft.print("Air sensor warming up "); tft.print(pct); tft.print("%");
    tft.drawRoundRect(6, 120, 148, 7, 3, COL_CARD_EDGE);
    tft.fillRect(7, 121, 146 * pct / 100, 5, COL_MINT);
  } else {
    tft.setTextColor(COL_MINT);
    tft.setCursor(6, 108); tft.print("Air sensor ready");
    tft.setTextColor(COL_SUBTEXT);
    tft.setCursor(6, 120); tft.print("Hold BOOT 5s = forget Wi-Fi");
  }
}

void drawInfo() {
  tft.fillScreen(COL_BG);
  tft.setTextSize(1);
  tft.setTextColor(COL_MINT);
  tft.setCursor(6, 6);
  tft.print("EcoVital pod");
  tft.setTextColor(COL_SUBTEXT);
  tft.setCursor(6, 22);
  tft.print("Pair code");
  tft.setTextSize(3);
  tft.setTextColor(ST77XX_WHITE);
  tft.setCursor(26, 34);
  tft.print(claimCode);
  tft.setTextSize(1);
  tft.setTextColor(COL_SUBTEXT);
  tft.setCursor(6, 66);  tft.print("ID "); tft.print(deviceId);
  tft.setCursor(6, 78);  tft.print("IP "); tft.print(WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : String("no Wi-Fi"));
  tft.setCursor(6, 90);
  if (apActive) { tft.print("Setup: join "); tft.print(apName); }
  else { tft.print("Wi-Fi "); tft.print(cfgSsid.substring(0, 18)); }
  tft.setCursor(6, 102); tft.print("fw "); tft.print(FW_VERSION); tft.print("  cloud "); tft.print(netState == 2 ? "on" : "off");
  infoStrip();
}

bool infoActive(uint32_t now) {
  if (!infoUntil) return false;
  if ((int32_t)(now - infoUntil) >= 0) { infoUntil = 0; bootInfo = false; forceRedraw(); return false; }
  if (bootInfo) {   // start-up screen: stay until the air sensor is warm and nobody is connected, 3 min at most
    bool clientHere = lastClientMs && (now - lastClientMs) < 30000;
    if (mqReady && !clientHere) { bootInfo = false; infoUntil = 0; forceRedraw(); return false; }
  }
  int sig = (WiFi.status() == WL_CONNECTED ? 1 : 0) | (apActive ? 2 : 0) | (netState == 2 ? 4 : 0) | (mqReady ? 8 : 0);
  if (infoDrawnAt == 0 || sig != infoSig) { infoSig = sig; infoDrawnAt = now ? now : 1; infoStripAt = now; drawInfo(); }
  else if (now - infoStripAt >= 1000) { infoStripAt = now; infoStrip(); }
  return true;
}

void handleButton(uint32_t now) {          // short press: show pairing screen. Hold 5 s: forget Wi-Fi.
  static bool down = false, longDone = false;
  static uint32_t t0 = 0;
  bool pressed = digitalRead(PIN_BTN) == LOW;
  if (pressed && !down) { down = true; t0 = now; longDone = false; }
  else if (pressed && down && !longDone && now - t0 >= 5000) { longDone = true; resetWifiAndRestart(); }
  else if (!pressed && down) {
    down = false;
    if (!longDone && now - t0 >= 40 && now - t0 < 2500) {
      if (sosActive) { sosActive = false; forceRedraw(); }
      else if (infoUntil) { infoUntil = 0; bootInfo = false; forceRedraw(); }
      else { infoUntil = now + 30000; infoDrawnAt = 0; }
    }
  }
}

// ---------- NETWORK ----------
bool wifiBegun = false;

void appendField(char* buf, size_t cap, size_t& pos, const char* key, const Sample& s, int idx, int dec) {
  if (s.st[idx] == 0) return;
  if (s.st[idx] == 2 || isnan(s.v[idx])) pos += snprintf(buf + pos, cap - pos, ",\"%s\":null", key);
  else pos += snprintf(buf + pos, cap - pos, ",\"%s\":%.*f", key, dec, s.v[idx]);
}

// returns the speech event id (>0) if the server wants us to speak, 0 if not, -1 on failure
const char* resetReasonStr() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "power";
    case ESP_RST_SW: return "restart";
    case ESP_RST_PANIC: return "crash";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT: return "watchdog";
    case ESP_RST_BROWNOUT: return "brownout";
    default: return "other";
  }
}

int postBatch(const Sample* batch, int n) {
  static char body[BATCH * 96 + 720];
  size_t cap = sizeof(body), pos = 0;
  uint32_t nowMs = millis();
  pos += snprintf(body + pos, cap - pos,
                  "{\"deviceId\":\"%s\",\"name\":\"%s\",\"location\":\"%s\",\"lat\":%.4f,\"lng\":%.4f,"
                  "\"fw\":\"%s\",\"mac\":\"%s\",\"claim\":\"%s\",\"rssi\":%d,\"uptimeS\":%lu,\"mqReady\":%s,\"heap\":%lu,\"rst\":\"%s\",\"drops\":%lu,\"dhtOk\":%s%s%s,\"readings\":[",
                  DEVICE_ID, DEVICE_NAME, DEVICE_LOC, DEVICE_LAT, DEVICE_LNG, FW_VERSION, macStr, claimCode,
                  WiFi.RSSI(), (unsigned long)(nowMs / 1000), mqReady ? "true" : "false",
                  (unsigned long)ESP.getFreeHeap(), resetReasonStr(), (unsigned long)wifiDrops, dhtFailed ? "false" : "true",
                  (gasAlarm || causeId == C_SMOKE) ? ",\"alarm\":\"gas\"" : "",
                  causeId == C_SMOKE ? ",\"cause\":\"smoke\"" : causeId == C_GAS ? ",\"cause\":\"gas\"" : causeId == C_DUST ? ",\"cause\":\"dust\"" : causeId == C_STUFFY ? ",\"cause\":\"stuffy\"" : "");
  for (int i = 0; i < n; i++) {
    pos += snprintf(body + pos, cap - pos, "%s{\"ageMs\":%lu", i ? "," : "", (unsigned long)(nowMs - batch[i].ms));
    appendField(body, cap, pos, "dust", batch[i], 0, 1);
    appendField(body, cap, pos, "air",  batch[i], 1, 1);
    appendField(body, cap, pos, "temp", batch[i], 2, 1);
    appendField(body, cap, pos, "hum",  batch[i], 3, 1);
    pos += snprintf(body + pos, cap - pos, "}");
  }
  pos += snprintf(body + pos, cap - pos, "]}");

  char url[160];
  snprintf(url, sizeof(url), "%s/api/ingest", API_BASE);

  WiFiClientSecure sec;
  WiFiClient plain;
  HTTPClient http;
  bool https = strncmp(API_BASE, "https", 5) == 0;
  if (https) { sec.setInsecure(); http.begin(sec, url); }
  else http.begin(plain, url);
  http.setTimeout(20000);                    // the server may call the AI before it answers
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", cfgTok.length() ? cfgTok.c_str() : DEVICE_KEY);
  int code = http.POST((uint8_t*)body, pos);
  int result = -1;
  if (code == 200) {
    String resp = http.getString();
    handleExtras(resp);
    result = 0;
    const char* sp = strstr(resp.c_str(), "\"speak\":{");
    if (sp) {
      const char* id = strstr(sp, "\"eventId\":");
      if (id) result = atoi(id + 10);
    }
  } else {
    Serial.printf("[net] upload failed: HTTP %d %s\n", code, code < 0 ? HTTPClient::errorToString(code).c_str() : "");
    if (code == 401 && cfgTok.length()) { cfgTok = ""; prefs.remove("tok"); Serial.println("[net] private token rejected, falling back to the setup key"); }
  }
  http.end();
  return result;
}

void netTask(void*) {
  uint32_t lastTry = 0, lastUpload = 0, downSince = 0;
  bool wasUp = false;
  uint32_t waitMs = UPLOAD_EVERY_MS;
  for (;;) {
    serviceAudio();
    portalTick();
    if (restartReq) { delay(800); ESP.restart(); }
    if (!wifiBegun) { WiFi.mode(WIFI_STA); WiFi.setSleep(false); WiFi.setAutoReconnect(true); WiFi.begin(WIFI_SSID, WIFI_PASS); wifiBegun = true; lastTry = millis(); }

    if (WiFi.status() != WL_CONNECTED) {
      netState = 0;
      if (wasUp) { wasUp = false; wifiDrops++; }
      if (!downSince) downSince = millis();
      // Saved network missing or wrong: after 40 s the pod opens its own "EcoVital-XXXX" Wi-Fi so you can pick another
      // network, and it keeps trying the saved one in the background. It closes again by itself once it connects.
      if (!apActive && (millis() - downSince > 40000 || !cfgSsid.length())) { startPortal(); Serial.println("[net] saved Wi-Fi not found, setup network opened"); }
      bool someoneSettingUp = apActive && WiFi.softAPgetStationNum() > 0 && (millis() - apOpenedAt < 180000UL);   // leave a phone alone for 3 min while it sets things up; after that keep trying the saved Wi-Fi
      if (millis() - lastTry > 20000 && !someoneSettingUp) { lastTry = millis(); if (cfgSsid.length()) { WiFi.disconnect(); WiFi.begin(WIFI_SSID, WIFI_PASS); } }
      vTaskDelay(pdMS_TO_TICKS(500));
      continue;
    }
    downSince = 0;
    onWifiUp();
    wasUp = true;
    if (netState == 0) netState = 1;

    if (replayRequested && lastEventId > 0) { replayRequested = false; playSpeech(lastEventId); }

    if ((millis() - lastUpload >= waitMs || uploadNow) && ringCount() > 0) {
      uploadNow = false;
      lastUpload = millis();
      static Sample batch[BATCH];
      int n = ringPeek(batch, BATCH);
      int r = postBatch(batch, n);
      if (r >= 0) {
        ringDrop(n);                      // only forget readings once the server has them
        lastOkMs = millis();
        netState = 2;
        waitMs = ringCount() > BATCH ? 2000 : UPLOAD_EVERY_MS;   // catch up quickly after an outage
        if (r > 0) { lastEventId = r; lastCloudSpeakMs = millis(); playSpeech(r); }
        if (otaPending && ringCount() <= 3 && !speaking) { otaPending = false; runOta(); }
      } else {
        netState = 1;
        waitMs = 8000;                    // retry sooner; the readings stay buffered
      }
    }
    vTaskDelay(pdMS_TO_TICKS(200));
  }
}

void recordSample(uint32_t nowMs) {
  Sample s;
  s.ms = nowMs;
  s.st[0] = !isnan(curDust) ? 1 : 0;           s.v[0] = curDust;
  s.st[1] = (mqReady && !isnan(curAir)) ? 1 : 0; s.v[1] = curAir;     // omitted while the MQ warms up
  if (!dhtTried) { s.st[2] = 0; s.st[3] = 0; }
  else if (dhtFailed) { s.st[2] = 2; s.st[3] = 2; }                   // sensor failed: send null so the server counts it
  else { s.st[2] = 1; s.st[3] = 1; }
  s.v[2] = curTemp; s.v[3] = curHum;
  if (s.st[0] || s.st[1] || s.st[2]) ringPush(s);
}

void handleSerial() {
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == 'c' || ch == 'C') {
      dustBaselineV = readDustVoltage(40);
      airBaselineV  = readMqVoltage(40);
      airCalibrated = true;
      prefs.putFloat("dust", dustBaselineV);
      prefs.putFloat("air",  airBaselineV);
      Serial.printf(">> Calibrated and saved. Dust baseline: %.3f V | Air baseline: %.3f V\n", dustBaselineV, airBaselineV);
    } else if (ch == 'g' || ch == 'G') {
      Serial.println(">> test gas alarm for 20 s");
      gasTestUntil = millis() + 20000;
    } else if (ch == 't' || ch == 'T') {
      Serial.println(">> test beep (speaker + amplifier)");
      replayRequested = false;
      beepRequest = 2;
    } else if (ch == 'p' || ch == 'P') {
      printPairing();
    } else if (ch == 'w' || ch == 'W') {
      resetWifiAndRestart();
    } else if (ch == 'a' || ch == 'A') {
      Serial.printf(">> playing offline alert clip %d of %d\n", testClip % CLIP_COUNT + 1, CLIP_COUNT);
      clipRequest = testClip++ % CLIP_COUNT;
    } else if (ch == 'i' || ch == 'I') {
      Serial.printf(">> Wi-Fi: %s, IP %s, RSSI %d dBm, buffered readings: %d, last upload OK %lu s ago\n",
                    WiFi.status() == WL_CONNECTED ? "connected" : "NOT connected",
                    WiFi.localIP().toString().c_str(), WiFi.RSSI(), ringCount(),
                    lastOkMs ? (unsigned long)((millis() - lastOkMs) / 1000) : 0UL);
      Serial.printf(">> dashboard: %s | node: %s\n", API_BASE, DEVICE_ID);
    } else if (ch == 'v' || ch == 'V') {
      if (lastEventId > 0) { Serial.printf(">> replaying event %d\n", lastEventId); replayRequested = true; }
      else Serial.println(">> nothing to replay yet");
    }
  }
}

// ---------- BOOT SCREEN + WELCOME ----------
#define BOOT_BG    0xFFFF      // white, matches the logo background
#define BOOT_GREEN 0x2D48
#define BOOT_TRACK 0xDEFB
#define BOOT_TEXT  0x4A69
#define LOGO_X 20
#define LOGO_Y 1
#define BAR_X  20
#define BAR_Y  107
#define BAR_W  120

void bootLogo() {
  tft.fillScreen(BOOT_BG);
  tft.drawRGBBitmap(LOGO_X, LOGO_Y, ecovitalLogo, LOGO_W, LOGO_H);
  tft.drawRoundRect(BAR_X - 1, BAR_Y - 1, BAR_W + 2, 7, 3, BOOT_TRACK);
}

void bootBar(int pct) {
  pct = constrain(pct, 0, 100);
  int w = (BAR_W * pct) / 100;
  tft.fillRect(BAR_X, BAR_Y, BAR_W, 5, BOOT_BG);
  if (w > 0) tft.fillRect(BAR_X, BAR_Y, w, 5, BOOT_GREEN);
}

void bootMsg(const char* msg) {
  tft.fillRect(0, 116, 160, 12, BOOT_BG);
  tft.setTextSize(1);
  tft.setTextColor(BOOT_TEXT);
  int len = strlen(msg);
  tft.setCursor((160 - len * 6) / 2, 118);
  tft.print(msg);
}

void playMelody(const int* freq, const int* dur, int n) {
  if (!i2sStart()) { Serial.println("[audio] I2S start failed"); return; }
  speaking = true;
  int16_t z[256 * 2] = {0};
  i2sWrite(z, sizeof(z));     // short silence so the amp wakes without a pop
  for (int i = 0; i < n; i++) { playTone(freq[i], dur[i]); delay(25); }
  speaking = false;
  i2sStop();
}

// Says "Welcome to EcoVital" from the clip stored in flash (works with no Wi-Fi)
void playWelcomeVoice() {
  if (!i2sStart()) { Serial.println("[audio] I2S start failed"); return; }
  speaking = true;
  int16_t z[256 * 2] = {0};
  i2sWrite(z, sizeof(z));
  int16_t frames[512 * 2];
  int fi = 0;
  for (size_t i = 0; i < WELCOME_SAMPLES; i++) {
    int16_t smp = (int16_t)pgm_read_word(&welcomePcm[i]);
    int32_t v = (int32_t)(smp * WELCOME_VOLUME);
    if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
    frames[fi++] = (int16_t)v; frames[fi++] = (int16_t)v;
    if (fi >= 512 * 2) { i2sWrite(frames, fi * 2); fi = 0; }
  }
  if (fi) i2sWrite(frames, fi * 2);
  i2sWrite(z, sizeof(z));
  speaking = false;
  i2sStop();
}

// ---------- SETUP / LOOP ----------
void setup() {
  Serial.begin(115200);
  Serial.println("\n=== EcoVital cloud node ===");
  Serial.printf("[boot] last reset reason: %s | free heap %lu\n", resetReasonStr(), (unsigned long)ESP.getFreeHeap());   // tells a power dip (brownout) from a software crash

  pinMode(PIN_DUST_LED, OUTPUT);
  pinMode(PIN_BTN, INPUT_PULLUP);
  digitalWrite(PIN_DUST_LED, HIGH);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_MQ, ADC_11db);
  analogSetPinAttenuation(PIN_DUST_VO, ADC_11db);
  dht.begin();
  initRingLUT();

  tft.initR(TAB);
  tft.setRotation(1);
  // tft.invertDisplay(true);        // uncomment if colours look inverted
  bootLogo();
  bootBar(5);  bootMsg("Welcome to EcoVital");

  // welcome tone: four rising notes
  static const int wf[] = {523, 659, 784, 1047};
  static const int wd[] = {120, 120, 120, 320};
  playMelody(wf, wd, 4);
  bootBar(18); bootMsg("Welcome to EcoVital");
  playWelcomeVoice();
  bootBar(30);

  bootMsg("Reading sensors");
  prefs.begin("ecovital", false);
  loadIdentity();
  float d = prefs.getFloat("dust", NAN);
  float a = prefs.getFloat("air",  NAN);
  if (!isnan(d)) dustBaselineV = d; else dustBaselineV = readDustVoltage(20);
  if (!isnan(a)) { airBaselineV = a; airCalibrated = true; }
  bootBar(45);

  bootMsg("Connecting Wi-Fi");
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setHostname(deviceId);
  if (cfgSsid.length()) WiFi.begin(WIFI_SSID, WIFI_PASS);
  WiFi.setTxPower(WIFI_POWER_11dBm);   // lower radio current spikes: helps weak USB ports avoid brown-out resets
  wifiBegun = true;
  uint32_t t0 = millis();
  int pct = 45;
  while (cfgSsid.length() && WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) {
    delay(150);
    if (pct < 88) pct++;
    bootBar(pct);
  }

  if (WiFi.status() == WL_CONNECTED) {
    String ip = WiFi.localIP().toString();
    Serial.printf("[wifi] connected to \"%s\", IP %s, signal %d dBm\n", WIFI_SSID, ip.c_str(), WiFi.RSSI());
    Serial.printf("[cloud] dashboard: %s   node id: %s\n", API_BASE, DEVICE_ID);
    bootBar(94);
    bootMsg(ip.c_str());
    static const int cf[] = {784, 1047};
    static const int cd[] = {110, 220};
    playMelody(cf, cd, 2);                          // connected chime
    char codeLine[24];
    snprintf(codeLine, sizeof(codeLine), "Pair code: %s", claimCode);
    bootMsg(codeLine);
    delay(2200);
  } else {
    Serial.println("[wifi] could not connect. Check WIFI_SSID / WIFI_PASS (2.4 GHz network only). Will keep retrying.");
    bootBar(94);
    startPortal();
    char apLine[28];
    snprintf(apLine, sizeof(apLine), "Join Wi-Fi %s", apName);
    bootMsg(apLine);
    delay(2600);
    bootMsg("then open 192.168.4.1");
    delay(2600);
    snprintf(apLine, sizeof(apLine), "Pair code: %s", claimCode);
    bootMsg(apLine);
    static const int ff[] = {392, 294};
    static const int fd[] = {160, 260};
    playMelody(ff, fd, 2);                          // "not connected" tone
    playClip(CLIP_WIFI_SETUP);                      // and say it
  }
  bootBar(100);
  delay(500);

  tft.fillScreen(COL_BG);
  lastHeaderState = -1;

  // network + voice run on core 0, the sensors and display stay on core 1 (the Arduino loop)
  startWebServer();
  printPairing();
  xTaskCreatePinnedToCore(netTask, "net", 16384, NULL, 1, NULL, 0);

  Serial.println("c = calibrate in clean air | t = test speaker | a = next offline alert clip | p = pairing info | w = forget Wi-Fi | v = replay last voice message | i = status");
}

void loop() {
  unsigned long now = millis();

  handleSerial();
  handleButton(now);

  if (speaking) audioQuietUntil = now + 1500;     // speaker current shakes the supply: skip sensor readings during sound and 1.5 s after
  bool audioQuiet = (int32_t)(now - audioQuietUntil) < 0;
  if (audioQuiet) { dustSumMv = 0; mqSumMv = 0; sampleN = 0; }   // throw away anything half-collected

  if (!audioQuiet && now - lastPulse >= 10) {
    lastPulse = now;
    takePulse();
  }

  if (now - lastSample >= 500 && sampleN > 0) {
    lastSample = now;
    float dustV = (dustSumMv / sampleN) / 1000.0f * DIVIDER;
    float mqV   = (mqSumMv   / sampleN) / 1000.0f * DIVIDER;
    dustSumMv = 0; mqSumMv = 0; sampleN = 0;
    latestDustV = dustV;
    latestMqV   = mqV;

    curDust = calcDustPercent(dustV);
    feed(wDust, curDust);

    if (!mqReady && now >= MQ_WARMUP_MS) {
      if (!airCalibrated) airBaselineV = mqV;
      mqReady = true;
    }
    if (mqReady) { curAir = calcAirQualityPercent(mqV); feed(wAir, curAir); gasStep(now, curAir); }
  }

  if (now - lastDht >= 2000) {
    lastDht = now;
    float h = dht.readHumidity();
    float t = dht.readTemperature();
    dhtTried = true;
    dhtFailed = isnan(t) || isnan(h);
    if (!dhtFailed) { curTemp = t; curHum = h; feed(wTemp, t); feed(wHum, h); }

    Serial.printf("Air: %s%.0f%% (%.3f V) | Dust: %.0f%% (%.3f V) | Temp: %.1f C | Hum: %.1f %% | Wi-Fi: %s | buffered: %d\n",
                  wAir.valid ? "" : "warming ", wAir.targetVal, latestMqV,
                  wDust.targetVal, latestDustV, wTemp.targetVal, wHum.targetVal,
                  netState == 2 ? "uploading" : netState == 1 ? "connected" : "off", ringCount());
    if (dhtFailed) Serial.println("  (DHT22 not reading - check data pin / pull-up)");
  }

  if (now - lastRecord >= SAMPLE_EVERY_MS && !isnan(curDust)) {
    lastRecord = now;
    recordSample(now);
    localAlertStep(now);
    diagnoseStep(now);
    connectionVoiceStep(now);
    predictStep();
    refreshAdvice(now);
    pushTrend(now);
  }
  servicePending(now);
  if (gasTrig) { gasTrig = false; recordSample(now); }

  if (otaBusy) {
    drawOtaScreen();
    wasOta = true;
  } else if (wasOta) {
    wasOta = false;
    otaDrawnPct = -1;
    forceRedraw();
  } else if (sosActive) {
    drawSosScreen(now);
    wasSos = true;
    if (now - sosStarted > 15000UL) { sosActive = false; forceRedraw(); }
  } else if (wasSos) {
    wasSos = false;
    forceRedraw();
  } else if (gasAlarm) {
    drawGasScreen(now);
    wasGas = true;
    if (!speaking && sirenRequest == 0 && (gasLastSound == 0 || now - gasLastSound >= 25000)) { gasLastSound = now; sirenRequest = 1; }
  } else if (wasGas) {
    wasGas = false;
    forceRedraw();
  } else if (infoActive(now)) {
    // pairing screen is showing
  } else if (now - lastFrame >= 25) {
    lastFrame = now;
    for (int i = 0; i < 4; i++) {
      animate(*widgets[i]);
      if (widgetChanged(*widgets[i])) renderWidget(*widgets[i]);
    }
    updateHeader(now);
    static uint32_t lastFoot = 0;
    if (now - lastFoot >= 500) { lastFoot = now; drawFooter(); }
  }
  if (calibrateReq) {
    calibrateReq = false;
    dustBaselineV = readDustVoltage(40);
    airBaselineV  = readMqVoltage(40);
    airCalibrated = true;
    prefs.putFloat("dust", dustBaselineV);
    prefs.putFloat("air",  airBaselineV);
    Serial.println(">> Calibrated from the web page");
  }
}
