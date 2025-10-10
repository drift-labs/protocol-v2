# Docs

## Prerequisites

To deploy the `switchboard-on-demand` docs site, you will need to install the Firebase CLI and connect your account.

```bash
curl -sL https://firebase.tools | upgrade=true bash
```

After logging in (using `firebase login`), you will also need to make sure that your Firebase account has access to the `switchboard-docs` project:

```bash
❯ firebase projects:list
✔ Preparing the list of your Firebase projects
┌────────────────────────┬────────────────────────┬────────────────┬──────────────────────┐
│ Project Display Name   │ Project ID             │ Project Number │ Resource Location ID │
├────────────────────────┼────────────────────────┼────────────────┼──────────────────────┤
│ Switchboard Docs       │ switchboard-docs       │ 659732266249   │ [Not specified]      │
└────────────────────────┴────────────────────────┴────────────────┴──────────────────────┘
```

If access is needed, contact [Mitch](mailto://mitch@switchboard.xyz) or [Jack](mailto://jack@switchboard.xyz).

## Generate / Deploy Site

To deploy the docs for the `switchboard-on-demand` Rust SDK, simply run the following script:

```bash
# Generates the docs site and opens locally.
pnpm docgen --open

# Generates the docs site and tries to deploy to Firebase.
#
# Note that you will need to be logged into the Firebase CLI (See above).
pnpm docgen:deploy
```
