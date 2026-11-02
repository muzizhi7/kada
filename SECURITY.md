# Security policy

Kada is an experimental local agent. Supported reporting target: the latest public preview on main. There is no production support SLA.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/muzizhi7/kada/security/advisories/new) if available. Do not post credentials, private task content or an exploit containing personal data in a public issue. If private reporting is unavailable, open a minimal issue asking for a private reporting channel without including vulnerability details.

Include the affected commit/version, platform, a minimal sanitized reproducer, impact and expected behavior. We cannot promise a response deadline.

## Execution boundary

Shell/file tools run as the current local user; there is no OS sandbox. Workspace path validation and local API authentication do not make arbitrary model-generated shell commands safe. Real computer-use and automatic learning are off by default. Cloud provider handling and external tool behavior remain governed by their own configurations.

See [privacy and permissions](docs/PRIVACY.md) before attaching diagnostics.
