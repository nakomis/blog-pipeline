# Blog Pipeline — Cloud-native blog content review pipeline with a web UI

<p align="center">
  <img src="docs/blog-pipeline-icon.png" alt="Blog Pipeline" width="280" />
</p>

## Support

If you find this useful, please consider buying me a coffee:

[![Donate with PayPal](https://www.paypalobjects.com/en_GB/i/btn/btn_donate_SM.gif)](https://www.paypal.com/donate?hosted_button_id=Q3BESC73EWVNN&custom=blog-pipeline)

## Table of Contents

<!-- toc -->

- [Overview](#overview)
- [Architecture Diagram](#architecture-diagram)
- [Repository Layout](#repository-layout)
- [Environments](#environments)
- [Project status](#project-status)
- [First deployment](#first-deployment)
- [Architecture Diagrams](#architecture-diagrams)
- [Support](#support)

<!-- tocstop -->

## Overview

Blog Pipeline is a cloud-native review pipeline for [blog.nakom.is](https://blog.nakom.is)
content. A push of a Markdown post to the `blog-content` repo triggers a multi-model
review loop: several LLM reviewers score the draft for publishability, a deterministic
gate decides whether to iterate, and Claude Sonnet re-drafts against the critique — up
to four rounds. Generated images, the proposed revision and the reviewer critiques land
in a staging queue ("the bag") for a final human review before publication.

The web UI shows every post by pipeline stage.

## Architecture Diagram

![Architecture](docs/architecture/blog-pipeline.svg)

## Repository Layout

| Directory | Contents |
|---|---|
| `web/` | React + Vite single-page app — the pipeline dashboard and approval UI |
| `infra/` | AWS CDK — API Gateway, Lambda, DynamoDB, Step Functions, CloudFront, Cognito |
| `docs/architecture/` | draw.io diagram source and generated SVGs |

## Environments

| Environment | Domain | AWS account |
|---|---|---|
| Sandbox | `pipeline.blog.sandbox.nakomis.com` | `975050268859` |
| Production | `pipeline.blog.nakomis.com` | `637423226886` |

## Project status

Work is tracked in Taiga under the **PIPE** prefix —
[taiga.nakom.is/project/blog-pipeline](http://taiga.nakom.is/project/blog-pipeline/).

| Story | Feature |
|---|---|
| PIPE-1 | Post dashboard — pipeline stage overview |
| PIPE-2 | Review trigger — webhook on blog-content push |
| PIPE-3 | Cloud review loop — Step Functions scored fan-out |
| PIPE-4 | The bag — staging queue and approval UI |
| PIPE-5 | Publish — commit to blog-content with optional schedule |
| PIPE-6 | FLUX image generation for posts |
| PIPE-7 | Cognito managed-login branding for the dashboard |

**PIPE-1 is implemented:** the dashboard read path is live — a React + Vite SPA
served from CloudFront, gated behind the shared Cognito user pool, listing every
post by pipeline stage from a REST API (`GET /posts`) backed by Lambda and
DynamoDB. The API has its own custom domain
(`api.pipeline.blog.[sandbox.]nakomis.com`) behind a CloudFront distribution that
injects the required API key, so the usage plan and quota are enforced without
exposing the key to the browser. The remaining stories (the review loop, the
staging queue, publishing) are built on top of it, story by story.

To populate the dashboard before the review loop exists, seed sample data:

```bash
cd infra && AWS_PROFILE=nakom.is-sandbox npm run seed-sandbox
```

The SPA reads its runtime config from `/config.json`; generate it before a local
run or a deploy with `web/scripts/set-config.sh [sandbox|prod|localhost]`.

## First deployment

There is one unavoidable manual step before CI can take over.

The GitHub Actions deploy role is itself created by CDK — it is the `GithubCiStack`.
So the *first* deployment cannot run through CI: there is no role for the workflow
to assume yet. Something holding AWS credentials has to create that role, and with
no separate repo-bootstrapping tooling, that something is a human at a workstation.

Both regions must be CDK-bootstrapped first (the CloudFront certificates live in
`us-east-1`):

```bash
npx cdk bootstrap aws://975050268859/eu-west-2 aws://975050268859/us-east-1
```

Then deploy everything once, per account. `cdk deploy --all` orders the stacks by
dependency — `WebCert` (us-east-1) → `BlogPipeline` → `Api` → `Web` → `GithubCi`:

```bash
cd infra

# Sandbox
AWS_PROFILE=nakom.is-sandbox NPM_ENVIRONMENT=sandbox npx cdk deploy --all

# Production — when ready to go live
AWS_PROFILE=nakom.is-admin NPM_ENVIRONMENT=prod npx cdk deploy --all
```

Once the CI role exists, every subsequent push deploys itself: the workflow assumes
the role and runs `cdk deploy`. The manual step is never needed again unless the CI
stack is torn down.

`cdk.context.json` is intentionally gitignored. A local deploy generates it from
account lookups and it stays on your machine; CI regenerates its own.

## Architecture Diagrams

`docs/architecture/blog-pipeline.drawio` is the source for the diagram above.
The SVG is auto-regenerated on commit by the pre-commit hook in `.githooks/pre-commit`.

To activate the hook after cloning:

```bash
git config core.hooksPath .githooks
```

## Support

If you find this useful, please consider buying me a coffee:

[![Donate with PayPal](https://www.paypalobjects.com/en_GB/i/btn/btn_donate_SM.gif)](https://www.paypal.com/donate?hosted_button_id=Q3BESC73EWVNN&custom=blog-pipeline)
