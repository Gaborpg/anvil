# anvil

Minimal Node/TypeScript CLI for local Anvil checkpointing backed by a hidden shadow Git repository.

## Commands

```bash
anvil timeline
anvil diff [checkpoint] [checkpoint]
anvil restore <checkpoint>
anvil explain <checkpoint>
anvil export [--preview] [--message "message"]
```

## Internal record command

The current scaffold includes an internal recording command to simulate AI-driven edits:

```bash
anvil __record --kind after_edit_batch --summary "Updated parser logic" --files src/parser.ts
```

## Development

```bash
npm install
npm run build
npm start -- timeline
```

## Local Review App

Run the backend API:

```bash
npm run build
node ./dist/server.js
```

Then open the local review app in development mode:

```bash
npm run dev:web
```

Or build the frontend and serve the bundled app through the backend:

```bash
npm run build:web
node ./dist/server.js
```
