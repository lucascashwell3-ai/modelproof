# Northwind platform — shared agent notes

## Repo layout
- services/ holds one folder per service.
- web/ is the customer site.
- infra/ is Terraform; never apply from a laptop.

## Build and test
- make check runs lint, types and unit tests.
- make test-e2e needs the local stack (make up).
- CI must be green before review.

## Pull requests
- One change per pull request.
- Title in the imperative mood.
- Link the ticket in the body.
- Add screenshots for UI changes.

## Code style
- TypeScript strict mode everywhere.
- No default exports.
- Prefer small pure functions.
- Name tests after the behaviour they check.

## Data
- Customer data never leaves the prod account.
- Use the fixtures in test/fixtures for examples.
- Migrations need a rollback.

## Reviews
- Two approvals for services/billing.
- One approval elsewhere.
- Reviewers check tests first.

## Incidents
- Page the on-call through the incident channel.
- Write the timeline as you go.
- Blameless write-up within five days.

- Keep this file current when a rule changes.
- Keep this file current when a rule changes.
- Keep this file current when a rule changes.
- Keep this file current when a rule changes.
- Keep this file current when a rule changes.
- Keep this file current when a rule changes.
- Keep this file current when a rule changes.
- Keep this file current when a rule changes.
- Keep this file current when a rule changes.
- Keep this file current when a rule changes.
- Keep this file current when a rule changes.
- Keep this file current when a rule changes.
- Keep this file current when a rule changes.
- Keep this file current when a rule changes.
- Keep this file current when a rule changes.
- Keep this file current when a rule changes.
- Keep this file current when a rule changes.
- Keep this file current when a rule changes.
- Keep this file current when a rule changes.
- Keep this file current when a rule changes.
- Last reviewed by the platform team.
