# Fork additions

This fork tracks [smp46/pingvin-share-x](https://github.com/smp46/pingvin-share-x) and adds two features.

## Direct download links

Share owners can create download links for a single file that work without the share page, a password or a sign-in. They are made for `curl`/`wget` on servers, kiosks and consoles you don't fully trust.

Open a share you own and click the terminal icon next to a file. Each link can have:

- a **label**, for example "build server"
- a **time limit**, or none
- a **max download count**, for example 1 for a one-time link

Links can be **revoked instantly**, one at a time or all at once. The dialog shows each link's status, download count, and when and from which IP it was last used.

```bash
curl -fLOJ 'https://share.example.com/api/dl/<token>/file.zip'
```

```bash
wget --content-disposition 'https://share.example.com/api/dl/<token>/file.zip'
```

- Every request that returns file content counts as one download, including resumed or partial (`Range`) requests. `HEAD` requests never count.
- A link also stops working when the share expires, is deleted, is being edited or reaches its max views. Each direct download counts as a share view.
- Tokens are stored hashed and are shown only once. An invalid, expired, revoked or used-up link always returns the same `404`.

## CLI uploads

Under **Account → CLI uploads** (`/account/cliUploads`) you create upload tokens. They are one-time by default; you can allow more uses, or 0 for unlimited until the token expires. Every token must expire within one year, and you choose how long the resulting shares live. Shares are created in your account, so your share permissions, max share count, share size limit, storage quota and the max share expiration all apply.

```bash
# one file (curl appends the file name when the URL ends with /)
curl -T ./file.zip https://share.example.com/api/cli/upload/<token>/
```

```bash
# several files into one share
curl -F file=@a.txt -F file=@b.log https://share.example.com/api/cli/upload/<token>
```

```bash
# from stdin
tar cz ./logs | curl -T - https://share.example.com/api/cli/upload/<token>/logs.tar.gz
```

```bash
# also get a one-time direct download link for the uploaded file
curl -T ./file.zip "https://share.example.com/api/cli/upload/<token>/file.zip?directLink=1&maxDownloads=1&linkExpiration=1-hour"
```

```powershell
Invoke-RestMethod -Method Put -InFile .\file.zip -Uri https://share.example.com/api/cli/upload/<token>/file.zip
```

The response is the share URL, followed by one direct link per file if you asked for them. Send `Accept: application/json` to get JSON instead.

Optional query parameters:

| Parameter | Meaning |
| --- | --- |
| `name` | Share name (3-30 characters) |
| `description` | Share description (max 512 characters) |
| `directLink=1` | Also create a direct download link for each uploaded file |
| `maxDownloads` | Download limit for those links |
| `linkExpiration` | Lifetime of those links, e.g. `30-minutes`, `1-hour`, `7-days`, `never` (default `1-hour`) |

Notes:

- At most 100 files per upload.
- A failed or aborted upload is rolled back, and the token use is given back.
- Uploads are streamed to `DATA_DIRECTORY/uploads/_temp` before being moved to local storage or S3, so that directory needs room for the largest upload.
- The token is part of the URL, so it can show up in reverse-proxy access logs. Prefer short-lived or one-time tokens.
