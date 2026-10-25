const e = $('On workflow error').first().json;
const wf = e.workflow?.name || 'unknown workflow';
const node = e.execution?.lastNodeExecuted || 'unknown node';
const msg = e.execution?.error?.message || e.trigger?.error?.message || 'unknown error';
return [{ json: {
  key: 'n8n_error:' + wf + ':' + node,
  subject: 'Σφάλμα στο "' + wf + '" (' + node + ')',
  text: msg + '\n\nExecution: ' + (e.execution?.url || e.execution?.id || '-'),
} }];
