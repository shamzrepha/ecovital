import Link from "next/link";
import LeadForm from "@/components/LeadForm";

const STEPS = [
  { n: "1", title: "Plug in the pod", body: "It joins your Wi-Fi from your phone in about two minutes. No computer needed, ever." },
  { n: "2", title: "Enter the code on its screen", body: "Each pod shows a 6-character code. Type it in the app and the pod is yours." },
  { n: "3", title: "Hear what to do", body: "When the air needs attention the pod says so out loud, and the app shows the reading, the reason and the advice." },
];

const FEATURES = [
  { title: "It talks", body: "Short spoken advice in the room, such as “Humidity is low. Drink some water.” and “All good now.” when things recover." },
  { title: "Works when Wi-Fi drops", body: "The pod keeps judging the air and speaking from built-in voice clips, then sends everything it saved when the connection returns." },
  { title: "Early warnings", body: "Straight-line trend forecasts tell you when a reading is heading for its limit. Each one is scored against “no change” so you can see whether it earns its keep." },
  { title: "Limits you control", body: "Classroom, bedroom, nursery, lab or office profiles, and every limit is editable per pod." },
  { title: "Many rooms, one account", body: "Add as many pods as you need, name them by room, and see them together." },
  { title: "Your data, your export", body: "Download any pod’s readings as CSV, share a read-only link with a teacher or parent, or delete your account and data." },
];

const READS = [
  ["Dust index", "0–100", "Relative index from an optical sensor against a clean-air baseline. Not PM2.5 or PM10."],
  ["Air index", "0–100, higher is cleaner", "Relative index from a gas sensor. Not CO₂ and not a gas concentration."],
  ["Temperature", "°C", "About ±0.5 °C."],
  ["Humidity", "% RH", "About ±2–5 %."],
];

export default function Landing() {
  return (
    <main>
      <section className="lp-hero">
        <div className="lp-inner lp-hero-grid">
          <div>
            <p className="lp-kicker">Air monitoring that speaks</p>
            <h1>Your air, explained out loud, with advice you can act on.</h1>
            <p className="lp-lead">
              EcoVital is a small pod for classrooms, offices and homes. It watches dust, air quality, temperature and humidity,
              tells the room what is wrong and what to do about it, and gives you a clear app to see every room.
            </p>
            <div className="lp-cta">
              <Link className="btn primary lp-btn" href="/signup">Create your account</Link>
              <a className="btn lp-btn" href="#contact">Get pods</a>
            </div>
          </div>
          <figure className="lp-sample" aria-label="Example of what the pod says">
            <figcaption>Example of what the pod says</figcaption>
            <q>Humidity is low. The air is dry. Drink some water.</q>
            <div className="lp-sample-row"><span className="dot watch" /> Humidity · watch <span className="tag-measured">Measured</span></div>
            <q>All good now. We are safe.</q>
            <div className="lp-sample-row"><span className="dot good" /> Back to normal</div>
          </figure>
        </div>
      </section>

      <section className="lp-section" id="how">
        <div className="lp-inner">
          <h2>Set up in minutes</h2>
          <div className="lp-grid three">
            {STEPS.map((s) => (
              <div className="lp-card" key={s.n}>
                <span className="lp-num">{s.n}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-section alt" id="features">
        <div className="lp-inner">
          <h2>Built for rooms that need real answers</h2>
          <div className="lp-grid three">
            {FEATURES.map((f) => (
              <div className="lp-card" key={f.title}>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-section" id="honest">
        <div className="lp-inner">
          <h2>What the pod measures, honestly</h2>
          <p className="lp-lead small">
            A pod uses low-cost sensors. We show what they can really tell you and label every value as Measured or Estimated.
            EcoVital gives advice you can act on. It makes no medical claims and does not control fans or purifiers.
          </p>
          <div className="lp-table" role="table" aria-label="What each reading means">
            {READS.map(([name, unit, note]) => (
              <div role="row" key={name}>
                <b role="cell">{name}</b>
                <span role="cell" className="u">{unit}</span>
                <span role="cell">{note}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-section alt">
        <div className="lp-inner">
          <h2>Who it is for</h2>
          <div className="lp-grid three">
            <div className="lp-card"><h3>Schools and universities</h3><p>Know when a lecture hall is stuffy, dusty during harmattan, or too hot, and get told what to do before it affects the class.</p></div>
            <div className="lp-card"><h3>Offices and clinics</h3><p>Keep a record of how each room behaves through the day and export it when you need to show it.</p></div>
            <div className="lp-card"><h3>Homes and nurseries</h3><p>A calm voice and a simple app for bedrooms and children’s rooms, with limits you can tighten.</p></div>
          </div>
        </div>
      </section>

      <section className="lp-section" id="contact">
        <div className="lp-inner lp-contact">
          <div>
            <h2>Get pods for your rooms</h2>
            <p className="lp-lead small">Tell us what you need to monitor and how many rooms. We will reply by email with availability and next steps.</p>
            <p className="note">Already have a pod? <Link href="/signup" style={{ textDecoration: "underline" }}>Create an account</Link> and add it with the code on its screen.</p>
          </div>
          <div className="card"><LeadForm /></div>
        </div>
      </section>
    </main>
  );
}
