# OpenCode Auto-Reviewer Plugin

OpenCode plugin that acts as a supervisor to detect conceptual loops

## Installation

```bash
npm install opencode-auto-reviewer
```

## Features

- Acts as an LLM-powered supervisor observing the agent trajectory.
- Detects conceptual rabbit holes where the agent is stuck but technically not in an exact loop.
- Provides hints, warnings, and critical interventions to nudge the agent back on track.
- Forces strategy changes when approaches fail to converge.

## Usage

This is a plugin for [OpenCode](https://github.com/opencode-ai). You can register it in your OpenCode configuration or agent setup:

```typescript
import { configureAgent } from '@opencode-ai/sdk';
import plugin from 'opencode-auto-reviewer';

const agent = configureAgent({
  plugins: [
    plugin({
      // Provide configuration options here
    })
  ]
});
```

## License

[MIT](LICENSE)
