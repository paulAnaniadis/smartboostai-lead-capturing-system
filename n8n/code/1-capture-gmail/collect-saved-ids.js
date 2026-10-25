const ids = [...new Set($input.all().map((i) => i.json.gmail_id).filter(Boolean))];
return ids.length ? [{ json: { ids } }] : [];
