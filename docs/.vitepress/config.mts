import { withMermaid } from 'vitepress-plugin-mermaid'

// VitePress site config for the brighttest docs. Mermaid diagrams are enabled via
// vitepress-plugin-mermaid (```mermaid fenced blocks render to SVG).
export default withMermaid({
  title: 'brighttest',
  description:
    'Unified BrightScript test runner — write Rooibos specs once, run headless or on-device with coverage.',
  cleanUrls: true,
  lastUpdated: true,

  // GitHub Pages serves a project site under /<repo>/, so assets must be prefixed with the repo name.
  // Set to '/brighttest/' assuming the repo is named `brighttest`. Change to match your repo name, or
  // to '/' if you deploy to a user/org site (<user>.github.io) or a custom domain.
  base: '/brighttest/',

  // The unreleased (main) build is published under /next/ and must not be indexed; releases are.
  // The docs site build sets BRIGHTTEST_DOCS_CHANNEL=next for that build only.
  transformHead() {
    return process.env.BRIGHTTEST_DOCS_CHANNEL === 'next'
      ? [['meta', { name: 'robots', content: 'noindex' }]]
      : []
  },

  // Shiki has no 'brightscript' grammar; VB is the closest for keywords like function/sub/if/then/end.
  markdown: {
    languageAlias: { brightscript: 'vb' },
  },

  themeConfig: {
    nav: [
      {
        text: 'Start',
        items: [
          { text: 'Quick start', link: '/guide/getting-started' },
          { text: 'CLI reference', link: '/guide/cli-reference' },
          { text: 'Example apps', link: '/guide/examples' },
          { text: 'Troubleshooting & how it works', link: '/guide/troubleshooting' },
        ],
      },
      { text: 'Writing tests', link: '/writing-tests/' },
      {
        text: 'Adopting',
        items: [
          { text: 'Adopting brighttest', link: '/guide/adopting' },
          { text: 'Assess a project', link: '/guide/assess' },
          { text: 'Agent skills', link: '/guide/agent-skills' },
          { text: 'Agent surface (MCP)', link: '/guide/mcp' },
        ],
      },
      {
        text: 'Network',
        items: [
          { text: 'Network recipe', link: '/guide/network-recipe' },
          { text: 'Network fault model', link: '/guide/net-faults' },
          { text: 'HTTP fixtures in specs', link: '/writing-tests/http-fixtures' },
          { text: 'roChannelStore fixtures', link: '/guide/store-fixtures' },
        ],
      },
      {
        text: 'Instrument & Studio',
        items: [
          { text: 'Instrumented builds', link: '/guide/instrument' },
          { text: 'Studio', link: '/guide/studio' },
        ],
      },
      { text: 'E2E', link: '/e2e/' },
      {
        text: 'CI',
        items: [
          { text: 'CI integration', link: '/guide/ci' },
          { text: 'Device shelf (CI)', link: '/guide/ci-device-shelf' },
          { text: 'Sharing a device (lease)', link: '/guide/device-lease' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/Ramon-Lobo/brighttest' },
    ],

    editLink: {
      pattern: 'https://github.com/Ramon-Lobo/brighttest/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Motivation & decisions', link: '/motivation' },
          { text: 'Architecture', link: '/architecture' },
          { text: 'Design decisions', link: '/decisions-summary' },
        ],
      },
      {
        text: 'Getting started',
        items: [
          { text: 'Quick start', link: '/guide/getting-started' },
          { text: 'CLI reference', link: '/guide/cli-reference' },
          { text: 'Example apps', link: '/guide/examples' },
          { text: 'Troubleshooting & how it works', link: '/guide/troubleshooting' },
        ],
      },
      {
        text: 'Adopting an existing app',
        collapsed: false,
        items: [
          { text: 'Adopting brighttest', link: '/guide/adopting' },
          { text: 'Assess a project', link: '/guide/assess' },
          {
            text: 'Agents',
            collapsed: false,
            items: [
              { text: 'Agent skills', link: '/guide/agent-skills' },
              { text: 'Agent surface (MCP)', link: '/guide/mcp' },
            ],
          },
        ],
      },
      {
        text: 'Network & fixtures',
        collapsed: false,
        items: [
          { text: 'Network recipe', link: '/guide/network-recipe' },
          { text: 'Network fault model', link: '/guide/net-faults' },
          { text: 'HTTP fixtures in specs', link: '/writing-tests/http-fixtures' },
          { text: 'roChannelStore fixtures', link: '/guide/store-fixtures' },
        ],
      },
      {
        text: 'Instrumentation & Studio',
        collapsed: false,
        items: [
          { text: 'Instrumented builds', link: '/guide/instrument' },
          { text: 'Studio', link: '/guide/studio' },
        ],
      },
      {
        text: 'CI & devices',
        collapsed: false,
        items: [
          { text: 'CI integration', link: '/guide/ci' },
          { text: 'Device shelf (CI)', link: '/guide/ci-device-shelf' },
          { text: 'Sharing a device (lease)', link: '/guide/device-lease' },
        ],
      },
      {
        text: 'Writing tests',
        collapsed: false,
        items: [
          { text: 'Start here', link: '/writing-tests/' },
          { text: '1. Your first test', link: '/writing-tests/first-test' },
          { text: '2. Anatomy of a test file', link: '/writing-tests/anatomy' },
          { text: '3. Assertions', link: '/writing-tests/assertions' },
          { text: '4. Organizing tests', link: '/writing-tests/organizing' },
          { text: '5. Parameterized tests', link: '/writing-tests/parameterized' },
          { text: '6. Setup & teardown', link: '/writing-tests/setup-teardown' },
          { text: '7. Mocks, stubs & spies', link: '/writing-tests/test-doubles' },
          { text: '8. SceneGraph & async tests', link: '/writing-tests/scenegraph-async' },
          { text: '9. Headless vs device', link: '/writing-tests/headless-vs-device' },
          { text: '10. Global context (seeding)', link: '/writing-tests/global-context' },
          { text: '11. Cookbook', link: '/writing-tests/cookbook' },
          { text: '12. Common mistakes', link: '/writing-tests/mistakes' },
          { text: 'Media state (headless)', link: '/writing-tests/media-state' },
          { text: 'State fixtures (headless)', link: '/writing-tests/state-fixtures' },
        ],
      },
      {
        text: 'End-to-end (on device)',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/e2e/' },
          { text: 'Flow reference', link: '/e2e/flows' },
          { text: 'Authoring flows', link: '/e2e/authoring' },
          { text: 'App state', link: '/e2e/app-state' },
          { text: 'Scaling & CI', link: '/e2e/scaling' },
        ],
      },
      {
        text: 'Contributing',
        items: [
          { text: 'Contributing guide', link: '/contributing' },
          { text: 'Maintainer internals', link: '/maintainers' },
        ],
      },
    ],

    outline: { level: [2, 3] },
    search: { provider: 'local' },
  },
})
