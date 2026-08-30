# Cellular line identity

`CellularEndpoint.id` is the durable internal identity. A SIM phone number is mutable endpoint metadata and may be absent until configuration or device/provider metadata verifies it.

## Runtime rules

- `MOCK`: reserved example numbers are allowed only with `lineNumberStatus: demo`; the dashboard labels them **DEMO NUMBER**.
- `LIVE_SERVICES` and `PHYSICAL_EDGE`: no built-in number is allowed. Configure `CELLULAR_LINE_NUMBER`, supply verified provider/device metadata, or omit the number and expose **LINE NUMBER NOT VERIFIED**.
- Outbound endpoint messaging and voice fail clearly while line metadata is unverified.
- A messaging or voice provider may bind to only one logical endpoint, preventing the two halves of one Android/SIM from being represented by conflicting identities.

## Repository occurrence classification

The reserved `555` values in `tests/`, mock adapters, and `config.dev.yaml`/`config.test.yaml` are fixture or explicitly labeled mock data. Values in documentation and HTML inputs are examples. Production `config.example.yaml` reads `${CELLULAR_LINE_NUMBER}` and has no demo fallback.
