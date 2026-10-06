# Installation Documentation

## Required Software

Program | Version | Download | Note
------- | ------- | -------- | ----
`NodeJS` | >= 22.12.0 | [**here**](https://nodejs.org/en/download/) | Since discordjs v14 is used, the version needs to be at least 22.12.0.
`Git` | Any | [**here**](https://git-scm.com/downloads) | &nbsp;

## Runtime environment

Copy `.env.example` to `.env`, then set `RPP_DISCORD_CLIENT_ID` and `RPP_DISCORD_TOKEN` before running `npm start`.
Never commit the populated `.env`. A `TokenInvalid` startup log means the local process cannot connect to Discord;
registered slash commands can remain visible in Discord but will display `The application did not respond` until a
valid bot process is connected. Restart the deployed process after changing its environment.

## Optional Software
To enable step-trace for cargoship and patrol helicopter, [**GraphicsMagick**](http://www.graphicsmagick.org/download.html) needs to be downloaded.

To enable `/intelimport cinfo` and `/intelimport f7`, install
[**Tesseract OCR**](https://github.com/tesseract-ocr/tesseract) with its local English model. On Debian/Ubuntu:

    $ sudo apt install tesseract-ocr tesseract-ocr-eng

The bot invokes `tesseract` locally and never downloads a model at runtime. If the executable is elsewhere, set
`RPP_TESSERACT_PATH` to its absolute path before starting the bot.

`Tesseract OCR unavailable: spawn tesseract ENOENT` means the service cannot find that executable. Verify
`command -v tesseract` and `tesseract --list-langs` under the deployment environment; `eng` must be listed. An import
rejected for this reason commits nothing and can be submitted again after installation.

Name reconciliation does not require Steam credentials or a Steam Web API key. F7 imports read bounded public Steam
persona names to validate each OCR-derived name/SteamID pair; a mismatched or unavailable row is excluded and shown as
an import warning. On an uncertain `/cinfo`, the bot can
make at most three candidate queries per batch through the existing rate-limited WarBandits provider and the bounded
public Steam profile-name reader. Provider failure is non-blocking and never turns an ambiguous candidate into a match.
Each image is read from one bounded Rust-UI color/luminance mask and from the original image; semantic completeness
selects the result, not a blind retry. Known persistent aliases are supplied through Tesseract's
[`--user-words`](https://github.com/tesseract-ocr/tesseract/blob/main/doc/tesseract.1.asc) file;
that temporary UTF-8 file is deleted after the process. The current English model is still insufficient for arbitrary
Unicode; unresolved members are stored as pending slots rather than invented. A cinfo preview can be corrected through
`Edit <tag>`: line 1 is the exact ClanTag, line 2 is `Established` as `MM/DD/YYYY HH:mm:ss` GMT, and every remaining
line is one exact player name. The complete correction is previewed again and remains uncommitted until Confirm.

Resolved `/cinfo` name shapes and unambiguous F7 name/SteamID rows are stored independently from the code in
`data/player-intelligence/<guild>/<battlemetricsServerId>/visual-alias-library.json`. The file is bounded, validated,
written atomically, ignored by Git and survives bot restarts/upgrades as long as the `data/player-intelligence`
directory is preserved. Schema 4 contains normalized binary word signatures, identity references, a bounded
glyph↔Unicode-grapheme journal and up to 2,000 manually confirmed OCR user words; it never stores screenshot pixels.
Schema 3 visual/glyph evidence is migrated intact. The glyph journal learns only from exact `/cinfo`
spellings already resolved to a stable identity and only when foreground runs form an unambiguous segmentation.
Connected/touching writing is skipped. Exact whole-word repeats may corroborate an existing identity; glyph and
approximate shapes only retrieve/rank candidates and cannot create a definitive link by themselves. A schema 1 file
is read compatibly, while a corrupt sidecar is preserved and disabled instead of silently reset.

Human transcription corrections with proven comma/`and` member boundaries are stored separately in
`data/player-intelligence/<guild>/<battlemetricsServerId>/ocr-correction-memory.json`. This bounded schema-1 sidecar
stores normalized binary member signatures and corrected Unicode names, never raw pixels or identities. It is written
only after Confirm/Replace, atomically, and survives restart/update with the same data directory. Exact repeats correct
the same member slot automatically; high-similarity repeats require a unique conservative winner. Conflicts, short-name
fuzzy matches, Reject and expired previews do not train or auto-correct.

The private `intel-imports` channel is created automatically when the guild is set up again or the bot restarts. A
manual message may contain 1 to 10 PNG/JPEG/WebP images. The bot detects F7 versus `/cinfo` from OCR anchors; an optional
leading `cinfo` or `f7` acts as a strict hint for every attached image. One image may contain several vertically
stacked `/cinfo` panels: repeated `ClanTag` anchors are split and validated independently, without fixed coordinates.
Tesseract TSV line identifiers are preserved, so close or vertically overlapping OCR boxes cannot merge a wrapped
player name with the next `Established` row. The anchor tolerates only common `l`/`I`/`1` OCR confusion; the date
itself still requires exact `MM/DD/YYYY HH:mm:ss` GMT syntax.
For a complete roster, comma and final standalone `and` separators isolate one temporary image row per member before
one additional bounded OCR pass. Comma pixels are excluded, and OCR lines are assigned by their sheet row rather than
array order, preventing a missing row from shifting later members. A changed spelling is accepted only through a unique
confirmed name/template; otherwise the prior member remains unchanged.
The same configured channel may be renamed (for example to `intel-reports`) without changing routing. A text-only
message can contain 1 to 100 complete SteamID64 values, one per non-empty line. Blank and duplicate lines are ignored,
while any invalid line rejects the whole lot. The bot shows known names/BattleMetrics IDs when they resolve uniquely,
keeps other IDs without a guessed name, and writes nothing until `Confirm import` is clicked. Existing background
identity sources may enrich missing names after confirmation.
Confirm/Reject/Replace/Keep button interactions are acknowledged immediately, before durable import work. Mutating
decisions are serialized per BattleMetrics server and protected by an in-flight token lock; Discord therefore receives
its response inside the interaction deadline even when another import is already writing. The original message shows
`Import processing…` or `Import queued…` until the final result replaces it.
If a roster remains incomplete, the bot first performs one distinct OCR read of only the roster field. A confirmed
manual correction is then added to the persistent user-word lexicon and supplied to future Tesseract reads; it is not
identity proof and cannot train a visual/glyph sample without an independently safe pixel boundary.
If the first pass loses the `Members` or `Established` label, the bot separately rereads the relative count/date row
with a numeric alphabet. A polluted multi-word tag is likewise reread from only the value area. All recovered fields
pass the same strict validators; no absolute screen position is assumed.
If the tag or date remains unreadable but the declared count and roster are editable, Discord keeps the preview and
shows `Edit <tag>` with Confirm disabled. The modal accepts tag on line 1, GMT `Established` on line 2, then exactly one
player per line; invalid data is rejected only at correction/confirmation boundaries and is never committed.
For `/cinfo`, capture/upload dates are ignored. Every panel independently infers the Tuesday/Friday 14:00 GMT regular
wipe from its own `Established`; forced wipes and intermediate observed boundaries are deliberately ignored. One image
may contain panels assigned to different wipes, and the preview exposes each assignment before the grouped Confirm.

## Editable in-game raid alert

Edit `config/raid-alarm.json` to change the recognized raid alert sent to Rust team chat:

```json
{
  "inGameMessageTemplate": ":exclamation: :poggers: GETTING RAIDED: {message}  :oldmanlaugh: :exclamation:"
}
```

The file is read again for each incoming raid, so no bot restart is required. Supported named placeholders are
`{title}` (localized title), `{message}` (localized complete detail without its final period), `{item}` and
`{location}`. The last two are available only when the producer supplied the canonical
`<item> destroyed at <location>` body. Keep the template on one line and below 512 characters. An absent/malformed
file, a template without at least one supported placeholder, an unknown placeholder, or unavailable
`{item}`/`{location}` logs a warning and uses the built-in `{message}` template; the Rust+ alert is still sent.

For the optional Windows region-capture helper, create a webhook only in that private channel. The Linux bot needs
only its numeric ID, never its token:

    $ export RPP_INTEL_IMPORT_WEBHOOK_IDS="123456789012345678"

On the Windows gaming PC, keep the complete webhook URL in the process environment and launch a user-driven capture:

    PS> $env:RPP_INTEL_DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/123456789012345678/SECRET'
    PS> npm.cmd run capture:intel
    PS> npm.cmd run capture:intel -- cinfo
    PS> npm.cmd run capture:intel -- f7

With no argument, image type detection is automatic; `cinfo` and `f7` are optional strict hints. Windows opens its
native region selector, uploads one PNG, then removes the temporary file. The webhook secret must remain only on that
PC and be rotated if exposed. The bot performs OCR and still requires confirmation in Discord;
the helper receives no Steam credential, Discord bot token or database access.


## Clone the repository

Open a terminal (`Git Bash` / `CMD` / `Terminal` / `PowerShell` or similar) and run the following commands:

    $ git clone https://github.com/alexemanuelol/rustplusplus.git
    $ cd rustplusplus
    $ npm install
