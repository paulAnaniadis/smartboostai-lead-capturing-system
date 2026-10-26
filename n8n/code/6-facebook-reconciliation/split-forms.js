const pages = $('Facebook pages').all();
const tokens = $('Get page token').all();
const since = Math.floor(Date.now() / 1000) - 48 * 3600;
const out = [];
$input.all().forEach((item, i) => {
  const idx = item.pairedItem?.item ?? i;
  const page = pages[idx].json;
  const token = tokens[idx].json.access_token;
  for (const f of item.json.data || []) {
    out.push({ json: { page_id: page.page_id, form_id: f.id, form_name: f.name, access_token: token,
      filtering: JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: since }]) } });
  }
});
return out;
