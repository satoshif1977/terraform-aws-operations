# Contributing

Thank you for your interest in contributing\!

## Reporting Issues

- Use **GitHub Issues** to report bugs or request features
- Include steps to reproduce, expected vs actual behavior, and relevant logs

## Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes following the code style guidelines below
4. Add or update tests as needed
5. Ensure all tests pass
6. Commit with a clear, descriptive message
7. Open a Pull Request against `main`

## Code Style

| Language | Formatter | Linter |
|----------|-----------|--------|
| Python | `black` | `ruff` |
| TypeScript / JavaScript | `prettier` | `eslint` |
| Terraform | `terraform fmt` | `terraform validate` |
| Go | `gofmt` | `go vet` |

## Testing

```bash
# Python
pytest

# TypeScript / JavaScript
npm test

# Terraform
terraform validate

# Go
go test ./...
```

## Commit Message Convention

Use the [Conventional Commits](https://www.conventionalcommits.org/) format:

```
feat: add new feature
fix: fix a bug
docs: update documentation
refactor: refactor code without changing behavior
test: add or update tests
chore: update dependencies or tooling
```

## Questions

Feel free to open an Issue for questions or discussion.
