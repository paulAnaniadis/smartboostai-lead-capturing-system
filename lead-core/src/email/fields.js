import { stripAccents } from '../translit.js';

// Ντετερμινιστική εξαγωγή «Ετικέτα: τιμή» (ή «Ετικέτα<TAB>τιμή», ή ετικέτα
// μόνη της σε γραμμή και τιμή στην επόμενη). Οι ετικέτες συγκρίνονται
// χωρίς τόνους, πεζά, χωρίς τελικό «:» ή «*».

export const FIELD_SYNONYMS = {
  name: ['όνομα', 'ονοματεπώνυμο', 'ονοματεπωνυμο', 'όνομα & επώνυμο', 'όνομα και επώνυμο', 'name',
    'full name', 'your name', 'το όνομά σας', 'ονομα'],
  first_name: ['first name', 'firstname', 'μικρό όνομα'],
  last_name: ['επίθετο', 'επώνυμο', 'last name', 'lastname', 'surname'],
  phone: ['τηλέφωνο', 'τηλ', 'κινητό', 'κινητό τηλέφωνο', 'τηλέφωνο επικοινωνίας', 'phone', 'mobile',
    'telephone', 'tel', 'phone number', 'your phone'],
  email: ['email', 'e-mail', 'e mail', 'ηλεκτρονικό ταχυδρομείο', 'διεύθυνση email', 'mail', 'your email',
    'email address'],
  message: ['μήνυμα', 'σχόλια', 'ενδιαφέρον', 'ενδιαφέρομαι για', 'περιγραφή', 'message', 'comments',
    'your message', 'ερώτηση'],
  property_code: ['κωδικός ακινήτου', 'κωδικός αγγελίας', 'κωδ. αγγελίας', 'κωδ αγγελίας', 'κωδικός',
    'κωδ. ακινήτου', 'property code', 'property id', 'listing id', 'listing code', 'ref', 'property_ref',
    'property_code', 'ακίνητο'],
  property_url: ['url', 'σελίδα', 'σελίδα ακινήτου', 'page url', 'property url', 'link', 'σύνδεσμος',
    'σύνδεσμος αγγελίας', 'αγγελία', 'page'],
};

export const normalizeLabel = (s) =>
  stripAccents(String(s).toLowerCase()).replace(/[*:]+\s*$/, '').replace(/\.$/, '').replace(/\s+/g, ' ').trim();

const LABEL_INDEX = new Map();
for (const [field, labels] of Object.entries(FIELD_SYNONYMS)) {
  for (const l of labels) LABEL_INDEX.set(normalizeLabel(l), field);
}

// «Ετικέτα: τιμή». Η ετικέτα είναι σύντομη (≤ 40 χαρακτήρες, ≤ 5 λέξεις) και δεν είναι URL.
const LABELED_LINE = /^([^:\t]{1,40}?)\s*(?::|\t)\s*(.*)$/;
const SIGNATURE = /^--\s*$/;
// Γραμμές που κλείνουν το μήνυμα (footers των form plugins). Κάθε parser προσθέτει δικές του.
const DEFAULT_MESSAGE_STOP = [
  /^(sent from|sent via|get outlook for|this e-?mail was sent)/i,
  /^(εστάλη από|στάλθηκε από|απεστάλη από|αποστολή από|λήψη του outlook|αυτό το e-?mail στάλθηκε)/i,
];

function labelOf(line) {
  const m = line.match(LABELED_LINE);
  if (m && !/https?|[()<>@]/i.test(m[1]) && m[1].trim().split(/\s+/).length <= 5) {
    return { label: m[1].trim(), field: LABEL_INDEX.get(normalizeLabel(m[1])) ?? null, value: m[2].trim() };
  }
  const bare = LABEL_INDEX.get(normalizeLabel(line));
  if (bare) return { label: line.trim(), field: bare, value: '' };
  return null;
}

/**
 * @returns {{ fields: Record<string,string[]>, extra: Record<string,string>, labelsFound: number }}
 * Κάθε πεδίο είναι λίστα (π.χ. δύο τηλέφωνα σε ξεχωριστές γραμμές).
 */
export function extractFields(text, { messageStop = [] } = {}) {
  const stops = [...DEFAULT_MESSAGE_STOP, ...messageStop];
  const fields = {};
  const extra = {};
  let labelsFound = 0;
  let current = null; // { field, extraKey, lines[] }

  const flush = () => {
    if (!current) return;
    const value = current.lines.join('\n').trim();
    if (current.field) {
      if (value) (fields[current.field] ??= []).push(value);
    } else if (current.extraKey && value) {
      extra[current.extraKey] = value;
    }
    current = null;
  };

  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim();
    if (SIGNATURE.test(line)) {
      flush();
      break; // υπογραφή/footer του form plugin: τέλος των πεδίων
    }
    const lab = line ? labelOf(line) : null;
    if (lab) {
      flush();
      if (lab.field) labelsFound += 1;
      current = { field: lab.field, extraKey: lab.field ? null : lab.label, lines: lab.value ? [lab.value] : [] };
      continue;
    }
    if (!current) continue;
    // Συνέχεια: το μήνυμα μαζεύει πολλές γραμμές. Τα άλλα πεδία μόνο αν είναι ακόμα κενά.
    if (current.field === 'message') {
      if (line && stops.some((re) => re.test(line))) {
        flush();
        continue;
      }
      current.lines.push(line);
    } else if (line && current.lines.length === 0) {
      current.lines.push(line);
    } else if (!line && current.field !== 'message') {
      flush();
    }
  }
  flush();
  return { fields, extra, labelsFound };
}
