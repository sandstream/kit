# Community Guidelines

Welcome to the kit community! This guide helps you get involved, ask questions, contribute, and connect with other members.

## Table of Contents

- [Getting Help](#getting-help)
- [GitHub Discussions](#github-discussions)
- [Reporting Issues](#reporting-issues)
- [Feature Requests](#feature-requests)
- [Contributing Code](#contributing-code)
- [Community Events](#community-events)
- [Code of Conduct](#code-of-conduct)

---

## Getting Help

### I have a question

**Before asking:**
1. Check [Docs](https://github.com/sandstream/kit) for existing guides
2. Search [GitHub Discussions](https://github.com/sandstream/kit/discussions) for similar questions
3. Review [FAQ](https://github.com/sandstream/kit/discussions) and existing [GitHub Issues](https://github.com/sandstream/kit/issues)

**Where to ask:**
- **General questions:** [GitHub Discussions → Help](https://github.com/sandstream/kit/discussions/categories/help)
- **Plugin development:** [GitHub Discussions → Plugin Development](https://github.com/sandstream/kit/discussions/categories/plugin-development)
- **Troubleshooting:** [GitHub Discussions → Troubleshooting](https://github.com/sandstream/kit/discussions/categories/troubleshooting)
- **Security issues:** Please see [Security Policy](SECURITY.md) — **DO NOT** open a public issue

### I found a bug

Please report bugs as GitHub Issues with:
1. **Title:** Clear, concise description
2. **Description:** What happened vs. what you expected
3. **Steps to reproduce:** Exact steps to trigger the bug
4. **Environment:** kit version, OS, Node.js version
5. **Logs:** Relevant error messages or debug output

See [Bug Report Template](#bug-report-template) below.

### I need commercial support

For production support, training, or consulting:
- Contact [hello@sandstre.am](mailto:hello@sandstre.am)
- Visit [kit Enterprise](https://github.com/sandstream/kit)

---

## GitHub Discussions

[GitHub Discussions](https://github.com/sandstream/kit/discussions) is our main community forum.

### Discussion Categories

#### 📢 Announcements
- **What:** Major updates, releases, breaking changes
- **Who can post:** Maintainers and core team
- **Use:** Stay informed about important kit news

#### 🆘 Help
- **What:** Questions about using kit
- **Who can post:** Anyone
- **Use:** Ask how to do things, troubleshoot issues
- **Response time:** Usually within 24 hours

#### 🚀 Feature Requests & Ideas
- **What:** Suggestions for new features
- **Who can post:** Anyone
- **Use:** Propose ideas and discuss improvements
- **Note:** See [Feature Request Process](#feature-requests) for full details

#### 🔧 Plugin Development
- **What:** Building custom plugins and adapters
- **Who can post:** Anyone
- **Use:** Share code, ask for code review, discuss plugin architecture
- **Related:** [Plugin Development Guide](docs/PLUGIN_DEVELOPMENT.md)

#### 📚 Showcase
- **What:** Projects using kit, creative use cases
- **Who can post:** Anyone
- **Use:** Share what you've built with kit

#### 🐛 Troubleshooting
- **What:** Debugging help for specific issues
- **Who can post:** Anyone
- **Use:** Ask for help resolving problems
- **Note:** Bug reports should use GitHub Issues (see below)

### Discussion Best Practices

**Do:**
- ✅ Search for similar discussions first
- ✅ Use clear titles and descriptions
- ✅ Include relevant code snippets or error messages
- ✅ Provide version information and context
- ✅ Mark helpful replies with reactions (👍)
- ✅ Follow the [Code of Conduct](CODE_OF_CONDUCT.md)

**Don't:**
- ❌ Duplicate existing discussions (link to the original instead)
- ❌ Post the same question across multiple channels
- ❌ Share API keys, passwords, or sensitive data
- ❌ Use discussions for bug reports (use Issues instead)
- ❌ Spam or self-promotion without community value

---

## Reporting Issues

### Bug Report Template

```markdown
## Description
Brief description of the issue

## Environment
- kit version: (e.g., 1.0.0)
- Node.js version: (e.g., 22.0.0)
- OS: (e.g., macOS 14.2)
- npm/yarn version: (e.g., 10.0.0)

## Steps to Reproduce
1. Step 1
2. Step 2
3. Step 3

## Expected Behavior
What should happen

## Actual Behavior
What actually happens

## Error Messages
```
Paste relevant error messages or logs
```

## Additional Context
Any other relevant information

## Reproduction
- [ ] Issue reproducible on latest version
- [ ] Reproducible with minimal example
- [ ] Related to security? (see SECURITY.md if yes)
```

### Issue Labels

We use labels to categorize and track issues:

| Label | Meaning |
|-------|---------|
| `bug` | Something is not working correctly |
| `feature` | New capability or enhancement |
| `documentation` | Missing or unclear documentation |
| `security` | Security vulnerability or concern |
| `performance` | Performance improvement needed |
| `good first issue` | Good for new contributors |
| `help wanted` | Maintainers seeking community help |
| `in progress` | Currently being worked on |
| `blocked` | Waiting on external dependency |

---

## Feature Requests

### How to Request a Feature

1. **Check existing requests** — Search [GitHub Issues](https://github.com/sandstream/kit/issues?q=is%3Aopen+is%3Aissue+label%3Afeature) and [Discussions](https://github.com/sandstream/kit/discussions/categories/feature-requests)

2. **Post in Discussions first** — Start in [Feature Requests & Ideas](https://github.com/sandstream/kit/discussions/categories/feature-requests) to discuss before creating an issue

3. **Create an issue** — If there's community interest, create a [Feature Request issue](https://github.com/sandstream/kit/issues/new?labels=feature)

### Feature Request Template

```markdown
## Description
Clear summary of the feature

## Problem it Solves
What problem does this solve for users?

## Proposed Solution
How should this feature work?

## Use Cases
Example scenarios where this feature would be useful

## Alternatives Considered
Other approaches or existing workarounds

## Implementation Notes
Any technical considerations or constraints
```

### Feature Priority Factors

We prioritize features based on:
- **Community demand** — How many people have requested it?
- **Alignment with roadmap** — Does it fit our product direction?
- **Complexity** — How much effort would it require?
- **Impact** — How many users would benefit?
- **Maintainability** — Can we support it long-term?

---

## Contributing Code

Ready to contribute? Awesome! See [CONTRIBUTING.md](CONTRIBUTING.md) for:
- Setup instructions
- Development workflow
- Testing requirements
- Pull request process
- Code style guidelines
- Commit message conventions

### Quick Start

```bash
# Fork the repository and clone
git clone https://github.com/YOUR_USERNAME/kit.git
cd kit

# Install dependencies
npm install

# Create a feature branch
git checkout -b feat/your-feature-name

# Make changes, commit, and push
git push origin feat/your-feature-name

# Open a pull request
# See CONTRIBUTING.md for checklist
```

### Types of Contributions We Welcome

- **Code** — Bug fixes, features, refactoring
- **Tests** — Improved test coverage, edge cases
- **Documentation** — Guides, examples, clarifications
- **Translations** — Localizing docs to other languages
- **Design** — UI/UX improvements (screenshots, mockups)
- **Community** — Helping in discussions, mentoring others

### Recognition

Contributors are recognized in:
- [CHANGELOG.md](CHANGELOG.md) for releases
- [GitHub Contributors](https://github.com/sandstream/kit/graphs/contributors) page
- Project README.md
- Monthly community digest (if applicable)

---

## Community Events

### Upcoming Events

- **Weekly Office Hours** — Tuesdays 10am UTC on [Zoom](https://github.com/sandstream/kit)
- **Monthly Community Call** — Third Friday at 3pm UTC
- **Quarterly Roadmap Review** — All-hands review of upcoming work

### How to Join

- Add to calendar: [kit Calendar](https://github.com/sandstream/kit)
- Watch repository for announcements
- Subscribe to [Newsletter](https://github.com/sandstream/kit)

### Organizing Events

Want to organize a kit meetup, workshop, or talk? 
- Email [hello@sandstre.am](mailto:hello@sandstre.am)
- We provide swag, promotional support, and discounts

---

## Code of Conduct

All community spaces are governed by our [Code of Conduct](CODE_OF_CONDUCT.md).

### Key Points

- Treat everyone with respect
- Harassment and discrimination are not tolerated
- Report violations to [hello@sandstre.am](mailto:hello@sandstre.am)
- We take enforcement seriously

---

## Communication Channels

| Channel | Use For | Response Time |
|---------|---------|----------------|
| [GitHub Issues](https://github.com/sandstream/kit/issues) | Bug reports, feature requests | 24-48 hours |
| [GitHub Discussions](https://github.com/sandstream/kit/discussions) | Questions, ideas, showcase | 24 hours |
| [Email](mailto:hello@sandstre.am) | Private concerns, security | 48 hours |
| [Twitter](https://twitter.com/kitio) | Announcements, news | N/A |
| [Discord](https://discord.gg/kit) | Real-time chat, community | Varies |
| [Slack Community](https://github.com/sandstream/kit) | Private workspace, enterprise | Varies |

---

## Resources

### Documentation
- [Getting Started](docs/GETTING_STARTED_PLUGINS.md)
- [API Reference](docs/COMMANDS.md)
- [Plugin Development](docs/PLUGIN_DEVELOPMENT.md)
- [FAQ](https://github.com/sandstream/kit/discussions)

### Examples
- [Example Plugins](packages/example-plugins/)
- [Sample Projects](docs/examples/)
- [Blog Posts](https://github.com/sandstream/kit)

### Learning
- [Video Tutorials](https://youtube.com/@kitio)
- [Blog](https://github.com/sandstream/kit)
- [Webinars](https://github.com/sandstream/kit)

---

## Feedback & Suggestions

Have feedback about the community or these guidelines?
- Open an issue with the `community` label
- Discuss in [Community Feedback](https://github.com/sandstream/kit/discussions)
- Email [hello@sandstre.am](mailto:hello@sandstre.am)

We value your input and continuously improve our community experience.

---

**Version:** 1.0  
**Adopted:** 2026-04-16  
**Last Updated:** 2026-04-16

**Welcome to the kit community! 🚀**
