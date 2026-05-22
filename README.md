# Blog Pipeline — Cloud-native blog content review pipeline with a web UI

## Support

If you find this useful, please consider buying me a coffee:

[![Donate with PayPal](https://www.paypalobjects.com/en_GB/i/btn/btn_donate_SM.gif)](https://www.paypal.com/donate?hosted_button_id=Q3BESC73EWVNN&custom=blog-pipeline)

## Table of Contents

<!-- toc -->
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
