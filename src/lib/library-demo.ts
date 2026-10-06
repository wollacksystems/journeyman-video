/**
 * Sample corpus for the askable-library demo on /journeyman.
 *
 * The demo is scripted: it answers from this fixed set of captured segments, so
 * it needs no network, no model, and no API tokens. The questions, the answers,
 * and the source stamp under each answer are all rendered into the page, and a
 * small client script only picks which answer is showing. `match` is the
 * keyword index the script scores a typed question against — that is what makes
 * the demo behave like retrieval without being one.
 *
 * The four jobs are the classic CNC diagnoses recorded in the Wollack Systems
 * memory (`raw/Common-CNC-Failures.md`); three of them are the v1 slate of the
 * synthetic capture corpus (`wiki/Synthetic_Environment.md`). The plant is a
 * sample, not a customer: no real floor, machine serial, or operator is named.
 */

export interface DemoSource {
  /** How the platform indexes the segment: its number in the session. */
  segment: string;
  /** Where the answer sits in the captured session, as mm:ss. */
  clock: string;
  /** How long the cited segment runs. */
  duration: string;
  /** The captured job it belongs to. */
  session: string;
  /** Who was recorded — the role, never a name (recorded workers stay unnamed). */
  role: string;
  machine: string;
  captured: string;
}

export interface DemoAnswer {
  /** Anchor for the question chip and the answer slip. */
  id: string;
  question: string;
  answer: string;
  /** Space-separated keywords scored against a typed question. */
  match: string;
  source: DemoSource;
}

export const DEMO_ANSWERS: DemoAnswer[] = [
  {
    id: 'atc-jam',
    question: 'The tool changer stopped mid-swap. Where do we start?',
    answer:
      'Back the arm off by hand, then clean the spindle taper. Chips in the cone or a worn retention knob stop the swap. Check pull-force before it runs again.',
    match:
      'tool changer changers atc swap jammed jam stuck halfway arm spindle cone taper retention knob gripper chips mid cycle toolchange change tooling pull force hanger',
    source: {
      segment: 'SEG 12',
      clock: '14:32',
      duration: '2:41',
      session: 'Tool changer jam',
      role: 'Maintenance technician',
      machine: 'VMC-04',
      captured: 'Apr 2026',
    },
  },
  {
    id: 'encoder-cable',
    question: 'An axis faults at one spot on the travel, then runs fine.',
    answer:
      'Suspect the energy chain, not the drive. A conductor inside it breaks and only opens at that position. Meter the cable before you order a drive.',
    match:
      'axis axes alarm faults fault error intermittent position travel spot place encoder cable cables e-chain chain conductor harness wiring wire broken flex drive feedback servo one same returns clears',
    source: {
      segment: 'SEG 04',
      clock: '09:18',
      duration: '3:06',
      session: 'Intermittent encoder fault',
      role: 'Maintenance technician',
      machine: 'VMC-04',
      captured: 'Apr 2026',
    },
  },
  {
    id: 'way-lube',
    question: 'A slide starves for oil and the servo trips.',
    answer:
      'The pump is fine; one branch is blocked. Pull the metering valve on the starving axis and clear the tramp-oil crust. Do not replace the pump.',
    match:
      'slide slides oil lube lubrication ways way starving starves servo trips overload pressure metering valve proportioning blocked blocked-up clogged tramp crust lubrication pump axis rails screw binding friction',
    source: {
      segment: 'SEG 09',
      clock: '21:40',
      duration: '1:58',
      session: 'Way-lube starvation',
      role: 'Maintenance technician',
      machine: 'Lathe 2',
      captured: 'Mar 2026',
    },
  },
  {
    id: 'false-interlock',
    question: 'The door interlock reads open, but the door is shut.',
    answer:
      'Wipe the switch before you chase the wiring. Dust and dried coolant bridge the contacts, so the controller thinks the door is open. Nothing is wrong mechanically.',
    match:
      'door interlock interlocks open shut closed switch switches sensor sensors proximity limit home false phantom dust dirt coolant coolant-dried probe clamped clamp safety guard wiped cleaning',
    source: {
      segment: 'SEG 02',
      clock: '07:05',
      duration: '1:12',
      session: 'False interlock trip',
      role: 'Machine operator',
      machine: 'Lathe 2',
      captured: 'Mar 2026',
    },
  },
];

/** mm:ss (or h:mm:ss) as seconds, so a segment can be placed in its session. */
export function clockSeconds(clock: string): number {
  const parts = clock.split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/**
 * A sample session length: the furthest point any cited segment reaches. It
 * gives the demo's scrub strips one shared timeline, the way a real library
 * would place four answers inside one plant's record.
 */
export function sampleSessionSeconds(answers: DemoAnswer[] = DEMO_ANSWERS): number {
  return Math.max(...answers.map(({ source }) => clockSeconds(source.clock) + clockSeconds(source.duration)));
}

/** How far along the sample session this segment sits, as a percentage. */
export function scrubPercent(entry: DemoAnswer, sessionSeconds = sampleSessionSeconds()): number {
  return Math.round((clockSeconds(entry.source.clock) / sessionSeconds) * 100);
}
