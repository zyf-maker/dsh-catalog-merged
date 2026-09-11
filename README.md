# dsh-catalog-merged

A GitHub-hosted **multi-source mirror** of the DeepSeek Harness plugin market.
Every 4 hours (and on demand) it merges the mainstream catalogs, de-duplicates
by plugin identity keeping the newest/hottest entry, and publishes a single
`plugins.json` for the `dshmarket` plugin to read.

## Sources

| source | URL | kind |
|---|---|---|
| awesome-dsh-plugin (official) | `https://awesome-dsh-plugin.com/plugins.json` | compiled `plugins.json` |
| DSH Get | `https://raw.githubusercontent.com/bobby-sheng/dshget-data/main/catalog.json` | snapshot JSON |
| unified-market | `https://raw.githubusercontent.com/jing-hy/dsh-unified-market/main/data/catalog-snapshot.json` | snapshot JSON |
| Oh-My-DSH | `https://raw.githubusercontent.com/JohnXu22786/Oh-My-DSH/main/data/plugins.json` | snapshot JSON |
| deepseek1024 | `https://api.deepseek1024.com/api/v1/registry` | public API (optional) |

Each source is optional: a fetch/parse failure is logged and that source is
skipped for that run, so a dead mirror never blanks the market.

## De-duplication

Plugins are keyed by npm package name when present, else by `owner/repo`, else by
display name (all lower-cased). For a duplicated identity the entry with the
highest `stars` (then `downloads`) is kept — the newest/hottest record wins.

## Point `dsh-market` at it

```sh
# restart dsh web while this env var is set
DSHM_REGISTRY_URL=https://raw.githubusercontent.com/zyf-maker/dsh-catalog-merged/main/plugins.json \
  dsh web
```

Re-open Settings → Plugin Market. The market then reads this merged catalog and
refreshes on every open; the catalog itself is rewritten every 4h by the
`scync` workflow.

## Regenerate

```sh
node merge.mjs        # writes plugins.json
```

## License

MIT