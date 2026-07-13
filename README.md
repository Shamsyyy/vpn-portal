# VPN Portal (shm137 + evka)

Статический сайт на **GitHub Pages**: оба сервера в одном интерфейсе, вход по паролю, редактирование клиентов.

## Сайт

После деплоя: `https://<username>.github.io/vpn-portal/`

**Пароль по умолчанию:** `vpn-portal-2026`

Сменить пароль:

```bash
python scripts/generate_auth.py "ваш-новый-пароль"
git add auth.json && git commit -m "chore: rotate portal password"
```

## Возможности

- Просмотр клиентов и инбаундов **shm137** и **evka**
- Ссылки на подписки, трафик, сроки
- Редактирование: вкл/выкл, лимит GB, срок, заметка
- Изменения сначала локально в браузере
- **Применить на серверах** — через GitHub (token + Action)

## GitHub Secrets (для авто-синка и применения)

| Secret | Описание |
|--------|----------|
| `SSH_PASS_SHM` | SSH root пароль shm137 |
| `SSH_PASS_EVKA` | SSH root пароль evka |

Панельные пароли читаются с сервера из `/opt/vpn-dashboard/config.json` — в GitHub не кладём.

## Локальное обновление данных

```bash
pip install paramiko
python scripts/export_portal_data.py
```

## Ручное применение изменений

```bash
python scripts/apply_changes.py data/overrides.json
```

## GitHub Pages

1. Создайте репозиторий `vpn-portal` на GitHub
2. Запушьте этот каталог
3. Settings → Pages → Source: **GitHub Actions**
4. Добавьте secrets `SSH_PASS_SHM`, `SSH_PASS_EVKA`
5. Actions → **Deploy GitHub Pages** — запустится автоматически

## Безопасность

- `auth.json` содержит только хеш пароля (PBKDF2)
- Данные клиентов и sub-ссылки — **чувствительные**; пароль обязателен
- Для публичного репозитория рассмотрите **private repo** + Pages (GitHub Pro) или смените subId после утечки
