const msgs = $input.first().json.messages || [];
return msgs.map((m) => ({ json: { id: m.id } }));
