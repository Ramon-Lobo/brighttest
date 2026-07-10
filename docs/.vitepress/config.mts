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

  // Shiki has no 'brightscript' grammar; VB is the closest for keywords like function/sub/if/then/end.
  markdown: {
    languageAlias: { brightscript: 'vb' },
  },

  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Quick start', link: '/guide/getting-started' },
      { text: 'Writing tests', link: '/writing-tests/' },
      { text: 'CI', link: '/guide/ci' },
      { text: 'Contributing', link: '/contributing' },
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
        ],
      },
      {
        text: 'Using brighttest',
        items: [
          { text: 'Quick start', link: '/guide/getting-started' },
          { text: 'CI integration', link: '/guide/ci' },
          { text: 'Agent skills', link: '/guide/agent-skills' },
          { text: 'Troubleshooting & how it works', link: '/guide/troubleshooting' },
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
