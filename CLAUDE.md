# Blog Pipeline

Cloud-native blog content review pipeline with a web UI. A push to the `blog-content`
repo triggers a multi-model LLM review loop; refined posts land in a staging queue for
human approval before publication.

## Stack

- **web/** — React + Vite SPA (Vitest for tests), behind CloudFront + Cognito
- **infra/** — AWS CDK (TypeScript): API Gateway, Lambda, DynamoDB, Step Functions
- **Review engine** — cloud LLM fan-out (Bedrock + Azure + Gemini + Anthropic); the
  review loop is orchestrated by AWS Step Functions
- **Re-draft model** — Claude Sonnet
- **Loop control** — deterministic, no LLM: re-loop if the minimum publishability
  score is below threshold or any reviewer raises a blocker, capped at 4 iterations

## AWS credentials

- Sandbox: `AWS_PROFILE=nakom.is-sandbox` (account `975050268859`)
- Production: `AWS_PROFILE=nakom.is-admin` (account `637423226886`)

## Environments

- Sandbox: `pipeline.blog.sandbox.nakomis.com`
- Production: `pipeline.blog.nakomis.com`

## Repository layout

- `web/` — React + Vite SPA
- `infra/` — AWS CDK
- `docs/architecture/` — draw.io source and generated SVGs

## Testing

- `infra/`: `npm test` — 70% coverage minimum
- `web/`: `npm test` (Vitest) — 70% coverage minimum

## Architecture diagrams

Source: `docs/architecture/blog-pipeline.drawio` — SVG auto-regenerated on commit by
`.githooks/pre-commit`.

To activate the hook after cloning:
```bash
git config core.hooksPath .githooks
```
