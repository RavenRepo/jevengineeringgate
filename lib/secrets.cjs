// Value-level secret detection for anything a hook would send to an engine.
//
// sanitizeState in decision-engine.cjs redacts secret-shaped keys. Command
// output and agent prompts have no keys: the secret is in the text. Text that
// holds one is not sent at all; a redaction that misses a shape leaks it, a
// refusal to send cannot.
const SHAPES = [
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\b(aws_secret_access_key|secret_access_key)\b\s*[:=]/i,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_\w{30,}\b/, // GitHub tokens
  /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}\b/, // OpenAI / Anthropic style keys
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, // Slack
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s@]+@/i, // a URL with a password: postgres://u:p@host, Neon, Redis
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/, // Authorization header
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}\b|\bwhsec_\w{16,}\b/, // Stripe keys and webhook secrets
  /\bnpm_[A-Za-z0-9]{36}\b/, // npm token
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /\bnapi_[a-z0-9]{40,}\b/, // Neon API key
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(api[_-]?key|apikey|secret|token|password|passwd|credential|auth)[\w-]*\s*[:=]\s*['"]?[^\s'"]{8,}/i,
  /^\s*[A-Z][A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=\S{8,}/m, // env-style assignment
  /\bdata:\s*\n(\s+[\w.-]+:\s+[A-Za-z0-9+/=]{16,}\n?)+/, // a Kubernetes Secret's data block
];

const holdsSecret = (text) => SHAPES.some((shape) => shape.test(String(text)));

/** A command with every VAR=value prefix's value struck, for use in a goal or a log line. */
const scrubCommand = (command) => String(command).replace(/\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, "$1=[redacted]");

module.exports = { holdsSecret, scrubCommand, SHAPES };
