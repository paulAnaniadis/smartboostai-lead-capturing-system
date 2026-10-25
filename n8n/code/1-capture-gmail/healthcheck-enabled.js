const url = $('Config').first().json.healthcheck_url;
return url ? [{ json: { url } }] : [];
