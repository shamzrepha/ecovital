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
#define DEFAULT_BASE  "https://your-app.vercel.app"   // no trailing slash
#define DEFAULT_KEY   "the-same-DEVICE_KEY-you-set-on-Vercel"
#define DEVICE_LOC   "FUTO, Owerri, Nigeria"
#define DEVICE_LAT   5.385f
#define DEVICE_LNG   6.998f
#define FW_VERSION   "1.1"
// The DEFAULT_ values above are only used the very first time. After that the pod uses what was saved from
// its setup page (join the "EcoVital-XXXX" Wi-Fi, or open http://<pod-ip>/), so you never reflash to change them.

String cfgSsid, cfgPass, cfgBase, cfgKey;                 // saved settings
char deviceId[24]   = "ecovital-000000";                  // from the chip's MAC address, never changes
char deviceName[40] = "EcoVital Pod";
char claimCode[8]   = "------";                           // 6-character pairing code shown on the pod
char macStr[18]     = "00:00:00:00:00:00";
char apName[20]     = "EcoVital-0000";
volatile float spkVol = 1.0f;                             // 0.0 - 1.0, set from the app
volatile bool  muted  = false;
#define WIFI_SSID   cfgSsid.c_str()
#define WIFI_PASS   cfgPass.c_str()
#define API_BASE    cfgBase.c_str()
#define DEVICE_KEY  cfgKey.c_str()
#define DEVICE_ID   deviceId
#define DEVICE_NAME deviceName

#define SPEAKER_VOLUME spkVol    // loudness of beeps and AI voice, set from the app
#define CLIP_VOLUME spkVol
#define WELCOME_VOLUME spkVol
#define UPLOAD_EVERY_MS 15000    // how often readings are sent
#define SAMPLE_EVERY_MS 5000     // how often a reading is recorded
// =====================================================================

// ---------- TFT ----------
#define TFT_CS   15
#define TFT_DC    2
#define TFT_RST   4
#define TAB INITR_BLACKTAB      // try INITR_GREENTAB / INITR_REDTAB if edges or colours look wrong
Adafruit_ST7735 tft = Adafruit_ST7735(TFT_CS, TFT_DC, TFT_RST);

GFXcanvas16 cardCanvas(74, 51);
GFXcanvas16 headerCanvas(160, 16);

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

// ---------- RING BUFFER (survives Wi-Fi outages, about 10 minutes) ----------
#define RING 120
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
SmartWidget wAir  = {  4, 20, "AIR",  "%",  0, 100,  70,  45, true,  NAN, {"GOOD","FAIR","POOR","--"},  COL_MINT, 100, 100, false, -1, -1, 255, false };
SmartWidget wDust = { 82, 20, "DUST", "%",  0, 100,  35,  65, false, NAN, {"LOW", "MOD", "HIGH","--"},  COL_MINT,   0,   0, false, -1, -1, 255, false };
SmartWidget wTemp = {  4, 74, "TEMP", "C",  0,  50,  30,  36, false, 16,  {"OK",  "WARM","HOT", "COOL"},COL_CYAN,  24,  24, false, -1, -1, 255, false };
SmartWidget wHum  = { 82, 74, "HUM",  "%",  0, 100,  68,  82, false, 30,  {"OK",  "DAMP","WET", "DRY"}, COL_MINT,  50,  50, false, -1, -1, 255, false };

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
  int speak = speaking ? (int)((now / 130) % 6) : -1;     // animated equaliser while speaking
  if (state == lastHeaderState && blink == lastHeaderBlink && net == lastHeaderNet && speak == lastHeaderSpeak) return;
  lastHeaderState = state; lastHeaderBlink = blink; lastHeaderNet = net; lastHeaderSpeak = speak;

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
  headerCanvas.setCursor(5, 5);
  headerCanvas.print("EcoVital");

  // cloud dot: green = uploading, amber = Wi-Fi but no upload yet, grey = no Wi-Fi
  uint16_t nc = (net == 2) ? COL_MINT : (net == 1) ? COL_AMBER : COL_TRACK;
  headerCanvas.fillCircle(60, 8, 3, nc);

  if (speak >= 0) {
    static const uint8_t pat[6][3] = {{3,8,5},{6,4,8},{8,6,3},{4,8,6},{7,3,8},{5,7,4}};
    for (int b = 0; b < 3; b++) {
      int h = pat[speak][b];
      headerCanvas.fillRect(67 + b * 3, 14 - h, 2, h, ST77XX_WHITE);
    }
  }

  headerCanvas.fillRoundRect(76, 2, 80, 13, 6, COL_CARD);
  headerCanvas.drawRoundRect(76, 2, 80, 13, 6, COL_CARD_EDGE);
  headerCanvas.fillCircle(83, 8, 2, blink ? col : blendHalf(col, COL_CARD));
  headerCanvas.setTextColor(col);
  headerCanvas.setCursor(90, 5);
  headerCanvas.print(text);

  tft.drawRGBBitmap(0, 0, headerCanvas.getBuffer(), 160, 16);
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
  mqSumMv += analogReadMilliVolts(PIN_MQ);
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

void playTone(float freq, int ms) {
  int n = SPEECH_RATE * ms / 1000;
  int16_t frames[256 * 2];
  int fi = 0;
  for (int i = 0; i < n; i++) {
    float env = 1.0f;
    if (i < 200) env = i / 200.0f; else if (i > n - 200) env = (n - i) / 200.0f;
    int16_t s = (int16_t)(sinf(2 * PI * freq * i / SPEECH_RATE) * 30000 * SPEAKER_VOLUME * env);
    frames[fi++] = s; frames[fi++] = s;
    if (fi >= 256 * 2) { i2sWrite(frames, fi * 2); fi = 0; }
  }
  if (fi) i2sWrite(frames, fi * 2);
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
static const Lim LIM[4] = { {35,  65,  NAN, NAN, 3.0f},    // 0 dust
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
      if (d <= -1.5f) { lastRapidAt = now; queueClip(CLIP_TEMP_DROP, 70, now); }
      else if (d >= 1.5f) { lastRapidAt = now; queueClip(CLIP_TEMP_RISE, 70, now); }
    }
    if (histN[0] >= 13 && locStatus[0] < ST_BAD_H && lastRapidAt != now) {
      float d = hist[0][histN[0] - 1] - hist[0][histN[0] - 13];
      if (d >= 25.0f) { lastRapidAt = now; queueClip(CLIP_DUST_SPIKE, 70, now); }
    }
  }
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
  for (uint32_t i = 0; i < n; i++) {
    int16_t a = ulaw2lin(pgm_read_byte(d + i)) * 4;          // 12 kHz -> 24 kHz: each sample plus the midpoint
    int16_t b = (i + 1 < n) ? ulaw2lin(pgm_read_byte(d + i + 1)) * 4 : a;
    int16_t o[2] = { a, (int16_t)(((int32_t)a + b) / 2) };
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
  if (clipRequest >= 0) { int c = clipRequest; clipRequest = -1; playClip(c); }
  if (beepRequest > 0)  { int c = beepRequest; beepRequest = 0; beepPattern(c); }
}

// ---------- PAIRING, SETUP PORTAL, LOCAL INFO, UPDATES (WLED style) ----------
#define PIN_BTN 0                         // the BOOT button on the dev board
WebServer webServer(80);
DNSServer dnsServer;
bool apActive = false, netServicesUp = false;
volatile bool otaBusy = false, otaPending = false;
volatile int otaPct = 0;
char otaUrlBuf[220] = "";
bool wasOta = false;
int otaDrawnPct = -1;
uint32_t infoUntil = 0, infoDrawnAt = 0;

void loadIdentity() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  snprintf(macStr, sizeof(macStr), "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  snprintf(deviceId, sizeof(deviceId), "ecovital-%02x%02x%02x", mac[3], mac[4], mac[5]);
  snprintf(apName, sizeof(apName), "EcoVital-%02X%02X", mac[4], mac[5]);
  snprintf(deviceName, sizeof(deviceName), "EcoVital Pod %02X%02X", mac[4], mac[5]);
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
  while (cfgBase.endsWith("/")) cfgBase.remove(cfgBase.length() - 1);
  if (cfgSsid == "YOUR_WIFI_NAME") cfgSsid = "";
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

static const char PAGE_HEAD[] PROGMEM = R"EV(<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>EcoVital pod</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#0d2136;color:#e2eefa}main{max-width:460px;margin:auto;padding:18px}h1{margin:0 0 2px}.c{background:#123150;border-radius:10px;padding:14px;margin:12px 0;line-height:1.6}.code{font-size:34px;letter-spacing:6px;font-weight:700;color:#62c1f0}input{width:100%;box-sizing:border-box;padding:10px;margin:4px 0 10px;border-radius:6px;border:1px solid #5f86ab;background:#0d2136;color:#e2eefa;font-size:16px}button{padding:12px 16px;border:0;border-radius:8px;background:#2f9e5f;color:#fff;font-size:16px}button.r{background:#a13a2f}small{color:#9bb7d1}</style></head><body><main>)EV";

void handleRoot() {
  String h = PAGE_HEAD;
  h += "<h1>EcoVital</h1><small>"; h += deviceName; h += "</small>";
  h += "<div class=c><small>Pair code</small><div class=code>"; h += claimCode;
  h += "</div><small>Enter this code in the EcoVital app to add this pod.</small></div>";
  h += "<div class=c>ID: "; h += deviceId;
  h += "<br>MAC: "; h += macStr;
  h += "<br>Firmware: "; h += FW_VERSION;
  h += "<br>Wi-Fi: ";
  if (WiFi.status() == WL_CONNECTED) { h += cfgSsid; h += " ("; h += WiFi.localIP().toString(); h += ")"; } else h += "not connected";
  h += "<br>Cloud: "; h += (netState == 2 ? "online" : "offline");
  h += "</div><div class=c>Dust: "; h += numStr(curDust);
  h += " &nbsp; Air: "; h += numStr(mqReady ? curAir : NAN);
  h += "<br>Temp: "; h += numStr(dhtFailed ? NAN : curTemp);
  h += " &nbsp; Humidity: "; h += numStr(dhtFailed ? NAN : curHum);
  h += "</div><form class=c method=POST action=/save><b>Wi-Fi</b><input name=ssid placeholder='Wi-Fi name'>";
  h += "<input name=pass type=password placeholder='Wi-Fi password'><b>Cloud</b>";
  h += "<input name=base placeholder='https://your-app.vercel.app' value='"; h += cfgBase;
  h += "'><input name=key placeholder='Device key (leave empty to keep)'><button>Save and restart</button></form>";
  h += "<form class=c method=POST action=/reset><button class=r>Forget Wi-Fi</button></form></main></body></html>";
  webServer.send(200, "text/html", h);
}

void handleSave() {
  if (webServer.arg("ssid").length()) {
    prefs.putString("ssid", webServer.arg("ssid"));
    prefs.putString("pass", webServer.arg("pass"));
    prefs.putBool("wiped", false);
  }
  if (webServer.arg("base").length()) prefs.putString("base", webServer.arg("base"));
  if (webServer.arg("key").length())  prefs.putString("key",  webServer.arg("key"));
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
    webServer.sendHeader("Access-Control-Allow-Origin", "*");
    webServer.send(200, "application/json", jsonInfo());
  });
  webServer.on("/save", HTTP_POST, handleSave);
  webServer.on("/reset", HTTP_POST, handleReset);
  webServer.onNotFound([]() {
    if (apActive) { webServer.sendHeader("Location", "http://192.168.4.1/", true); webServer.send(302, "text/plain", ""); }
    else webServer.send(404, "text/plain", "Not found");
  });
  webServer.begin();
}

void startPortal() {                       // pod's own Wi-Fi so you can give it your Wi-Fi details
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(apName);
  delay(150);
  dnsServer.start(53, "*", WiFi.softAPIP());
  apActive = true;
  Serial.printf("[setup] join Wi-Fi \"%s\" then open http://192.168.4.1/\n", apName);
}

void onWifiUp() {                          // runs on the network core whenever Wi-Fi is connected
  if (apActive) { apActive = false; dnsServer.stop(); WiFi.softAPdisconnect(true); WiFi.mode(WIFI_STA); }
  if (netServicesUp) return;
  netServicesUp = true;
  ArduinoOTA.setHostname(deviceId);
  ArduinoOTA.setPassword(claimCode);
  ArduinoOTA.onStart([]() { otaBusy = true; otaPct = 0; });
  ArduinoOTA.onProgress([](unsigned int c, unsigned int t) { otaPct = t ? (int)(c * 100UL / t) : 0; });
  ArduinoOTA.onEnd([]() { otaPct = 100; });
  ArduinoOTA.onError([](ota_error_t e) { otaBusy = false; });
  ArduinoOTA.begin();                      // also starts mDNS: http://<deviceId>.local
  MDNS.addService("ecovital", "tcp", 80);
  MDNS.addServiceTxt("ecovital", "tcp", "id", deviceId);
  MDNS.addServiceTxt("ecovital", "tcp", "fw", FW_VERSION);
  MDNS.addServiceTxt("ecovital", "tcp", "mac", macStr);
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
  char ver[24], url[220];
  if (jsonStr(r, "otaVersion", ver, sizeof(ver)) && jsonStr(r, "otaUrl", url, sizeof(url))) {
    if (strcmp(ver, FW_VERSION) != 0 && strncmp(url, "http", 4) == 0) { strcpy(otaUrlBuf, url); otaPending = true; }
  }
}

void runOta() {
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
  tft.setTextColor(COL_AMBER);
  tft.setCursor(6, 116); tft.print("Hold BOOT 5s = forget Wi-Fi");
}

bool infoActive(uint32_t now) {
  if (!infoUntil) return false;
  if ((int32_t)(now - infoUntil) >= 0) { infoUntil = 0; forceRedraw(); return false; }
  if (infoDrawnAt == 0 || now - infoDrawnAt > 5000) { infoDrawnAt = now ? now : 1; drawInfo(); }
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
      if (infoUntil) { infoUntil = 0; forceRedraw(); }
      else { infoUntil = now + 15000; infoDrawnAt = 0; }
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
int postBatch(const Sample* batch, int n) {
  static char body[BATCH * 96 + 520];
  size_t cap = sizeof(body), pos = 0;
  uint32_t nowMs = millis();
  pos += snprintf(body + pos, cap - pos,
                  "{\"deviceId\":\"%s\",\"name\":\"%s\",\"location\":\"%s\",\"lat\":%.4f,\"lng\":%.4f,"
                  "\"fw\":\"%s\",\"mac\":\"%s\",\"claim\":\"%s\",\"rssi\":%d,\"uptimeS\":%lu,\"mqReady\":%s,\"readings\":[",
                  DEVICE_ID, DEVICE_NAME, DEVICE_LOC, DEVICE_LAT, DEVICE_LNG, FW_VERSION, macStr, claimCode,
                  WiFi.RSSI(), (unsigned long)(nowMs / 1000), mqReady ? "true" : "false");
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
  http.addHeader("X-Device-Key", DEVICE_KEY);
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
  }
  http.end();
  return result;
}

void netTask(void*) {
  uint32_t lastTry = 0, lastUpload = 0;
  uint32_t waitMs = UPLOAD_EVERY_MS;
  for (;;) {
    serviceAudio();
    portalTick();
    if (!wifiBegun) { WiFi.mode(WIFI_STA); WiFi.setAutoReconnect(true); WiFi.begin(WIFI_SSID, WIFI_PASS); wifiBegun = true; lastTry = millis(); }

    if (WiFi.status() != WL_CONNECTED) {
      netState = 0;
      if (millis() - lastTry > 20000) { lastTry = millis(); if (cfgSsid.length()) { WiFi.disconnect(); WiFi.begin(WIFI_SSID, WIFI_PASS); } }
      vTaskDelay(pdMS_TO_TICKS(500));
      continue;
    }
    onWifiUp();
    if (netState == 0) netState = 1;

    if (replayRequested && lastEventId > 0) { replayRequested = false; playSpeech(lastEventId); }

    if (millis() - lastUpload >= waitMs && ringCount() > 0) {
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
        if (otaPending && ringCount() == 0 && !speaking) { otaPending = false; runOta(); }
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
    delay(2500);
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
  }
  bootBar(100);
  delay(700);

  tft.fillScreen(COL_BG);                           // dashboard screen takes over
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

  if (now - lastPulse >= 10) {
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
    if (mqReady) { curAir = calcAirQualityPercent(mqV); feed(wAir, curAir); }
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
  }
  servicePending(now);

  if (otaBusy) {
    drawOtaScreen();
    wasOta = true;
  } else if (wasOta) {
    wasOta = false;
    otaDrawnPct = -1;
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
  }
}
