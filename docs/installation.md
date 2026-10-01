# Installation Documentation

## Required Software

Program | Version | Download | Note
------- | ------- | -------- | ----
`NodeJS` | >= 22.12.0 | [**here**](https://nodejs.org/en/download/) | Since discordjs v14 is used, the version needs to be at least 22.12.0.
`Git` | Any | [**here**](https://git-scm.com/downloads) | &nbsp;

## Optional Software
To enable step-trace for cargoship and patrol helicopter, [**GraphicsMagick**](http://www.graphicsmagick.org/download.html) needs to be downloaded.

To enable `/intelimport cinfo` and `/intelimport f7`, install
[**Tesseract OCR**](https://github.com/tesseract-ocr/tesseract) with its local English model. On Debian/Ubuntu:

    $ sudo apt install tesseract-ocr tesseract-ocr-eng

The bot invokes `tesseract` locally and never downloads a model at runtime. If the executable is elsewhere, set
`RPP_TESSERACT_PATH` to its absolute path before starting the bot.

The private `intel-imports` channel is created automatically when the guild is set up again or the bot restarts. A
manual message may contain 1 to 10 PNG/JPEG images. The bot detects F7 versus `/cinfo` from OCR anchors; an optional
leading `cinfo` or `f7` acts as a strict hint for every attached image. One image may contain several vertically
stacked `/cinfo` panels: repeated `ClanTag` anchors are split and validated independently, without fixed coordinates.

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
