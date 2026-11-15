# Reglas de Git

- Repositorio solo local. Prohibido `git push` y crear remotos sin autorización.
- Solo el arquitecto hace commits, después de la aprobación del auditor.
- Commits en inglés, formato `<type>(<scope>): <summary> [<TASK-ID>]`.
- Antes de commitear: `git status` y revisar que no haya secretos, tokens, `.env*`, `target/` ni `node_modules/`.
- Un ejecutor por conjunto de archivos a la vez; para trabajo paralelo usar `isolation: worktree`.
