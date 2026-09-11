# Plugin Market

A marketplace inside DeepSeek Harness: it harvests plugin catalogs published across the
community, merges them into one de-duplicated dataset, and serves that dataset to a
settings section where a person browses, filters and installs plugins.

## Language

### The dataset

**Catalog**:
The merged, de-duplicated set of plugins the market serves. One plugin appears once, no
matter how many places listed it.
_Avoid_: registry, index, list

**Source**:
One place the catalog is read from — a published JSON, an API, or a discovery channel such
as a repository topic. The catalog is the union of its sources.
_Avoid_: feed, upstream, provider

**Identity**:
What makes two records the same plugin. npm package name, else repository path, else
display name — and a repository only counts when exactly one package claims it.
_Avoid_: key, hash, id

**Admission**:
The check that makes a repository eligible to be listed as a plugin: it must declare a
plugin manifest. A topic tag is a claim; admission is the evidence.
_Avoid_: validation, vetting, verification

**Source count**:
How many sources listed a plugin. The only popularity signal available for the third of the
catalog that has neither stars nor downloads.
_Avoid_: coverage, mentions

### Placing a plugin

**Category**:
What a plugin *is*, as one browsable bucket — Interface, Memory, Security. Fixed taxonomy of
19; the left column of the market.
_Avoid_: 类型, type, kind, tag, group

**Install target**:
*How* a plugin is obtained: `npm`, `github`, `tarball`. Orthogonal to category — a plugin has
exactly one, and it says nothing about what the plugin does.
_Avoid_: 类型, type, source, channel, format

**Auto-classification**:
Placing one plugin into a category by reading its own name and description, when the source
catalog's own category says nothing (a third of the catalog arrives tagged with the
framework's name rather than a subject).
_Avoid_: tagging, guessing, inference

**Discovery**:
The pipeline creating a *new* category because a cluster of plugins has no home. Distinct
from auto-classification, which only uses categories that already exist.
_Avoid_: clustering, learning, suggestion

**Proposal**:
A candidate category that discovery found but did not create, because the term describes
what a plugin integrates with rather than what it is. A person promotes a proposal by naming
it in the labels file.
_Avoid_: suggestion, candidate, pending category

### Signals shown to a reader

**Score**:
The ranking number: stars weighted far above downloads. Degenerates to zero for a third of
the catalog, which is why it is never the only thing a row says.
_Avoid_: rating, weight, rank

**Risk flag**:
A fact that changes whether a plugin is safe to install — it opens a terminal surface, needs
credentials, or runs scripts at install time.
_Avoid_: warning, alert, issue

**Unproven**:
An install target inferred from a repository whose manifest could not be read. Listed without
a working install button. Never means "not a plugin"; it means "we could not ask".
_Avoid_: unverified, unknown, invalid

**Update time**:
When the catalog was last rebuilt. Shown so an empty result can be told from a stale one.
_Avoid_: sync time, build time
