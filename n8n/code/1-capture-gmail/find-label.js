const name = $('Config').first().json.label_name;
const label = ($input.first().json.labels || []).find((l) => l.name === name);
if (!label) throw new Error('Λείπει το Gmail label "' + name + '". Φτιάξ\' το στο Gmail (βλ. docs/SETUP.md).');
return [{ json: { label_id: label.id } }];
