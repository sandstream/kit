# sandstream-kit-plugin-stripe

Stripe Management API client for account inspection and webhook endpoints. It exports an API client, not a `kit add` payments adapter.

## Installation

```bash
npm install sandstream-kit-plugin-stripe
```

## Configuration

Set `STRIPE_SECRET_KEY` in your secret manager, or pass `secretKey` to `makeClient`. The client detects test, live, restricted, and unknown key modes. Use a test key when exploring the API.

## Usage

```js
import { makeClient, getAccount } from "sandstream-kit-plugin-stripe";

const client = makeClient();
const account = await getAccount(client);
console.log(account.id);
```

## API

`getAccount` and `listWebhookEndpoints` read account data. `createWebhookEndpoint` and `deleteWebhookEndpoint` change endpoints and enforce kit's read-only and policy controls. `assertModeForUrl` checks key mode against webhook URL before creation.

## Testing

From the repository root, run `npm run build` and `npm test` to compile and run the package's tests in the monorepo suite. This package has no standalone `npm test` script.

## Troubleshooting

- `STRIPE_SECRET_KEY not set`: provide a key through the environment or `makeClient`.
- Webhook URL refused: check the key's mode and `assertModeForUrl` result before creation.
- Write refused: check `KIT_READ_ONLY` and the project's agent-write policy.

## Support

Report package issues in [sandstream/kit issues](https://github.com/sandstream/kit/issues).

## Version

Current package version: `0.2.2`. See [CHANGELOG.md](./CHANGELOG.md).
