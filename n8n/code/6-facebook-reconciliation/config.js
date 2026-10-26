// ΡΥΘΜΙΣΕΙΣ
// graph_version: έκδοση του Graph API της Meta (δες developers.facebook.com/docs/graph-api/changelog)
// token_mode:
//   'page'        → το credential «Meta System User» περιέχει token ΣΕΛΙΔΑΣ (δοκιμές / μία σελίδα)
//   'system_user' → το credential περιέχει token System User, που ανταλλάσσεται με token κάθε σελίδας
return [{ json: { graph_version: 'v26.0', token_mode: 'page' } }];
