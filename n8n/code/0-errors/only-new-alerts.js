// Αν η βάση δεν απαντάει, στέλνουμε έτσι κι αλλιώς.
return $input.all().filter((i) => i.json.send !== false).map((i, n) => ({ json: {
  subject: i.json.subject || $('Format').first().json.subject,
  body: i.json.body || $('Format').first().json.text,
} }));
