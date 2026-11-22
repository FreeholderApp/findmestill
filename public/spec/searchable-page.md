# Publish a searchable contact page

In the app, open **Make my contact searchable**. Enter the public name you
want to use, your signed contact link, and the URL where the human-readable
page will live. Select **Prepare public block**. Paste the text into your
website editor, making the entire signed contact link clickable, or select
**Download HTML page** and put the file at the chosen address. The app
prepares it locally. Publishing it on your website is a separate step.

The CLI also generates public HTML from your signed card. For example, serve the
HTML at `https://your-domain.example/fms` and the signed JSON at
`https://your-domain.example/fms/card.json`. Replace the example values below
with your own reviewed public URL, stable ID and name.

```sh
node client.mjs publish-page https://your-domain.example/fms "$CONTACT_ID" current.json "Public contact name" > fms.html
```

On a dedicated reference host, run `npm run build`, place the generated HTML
in `dist/fms/index.html` and its signed JSON in `dist/fms/card.json`, and
start the server behind HTTPS. Keep your published copies outside the build
directory and restore them after each build. The reference host serves the
HTML at exactly `/fms` when installed. You can serve the same two files from
an existing personal site.

The page includes the complete stable ID as visible text and a copyable card
link. Publish it over HTTPS with status 200, link it from a public page and
include it in your own sitemap. Permit crawlers to read it. After moving,
publish a successor signed by the same root, regenerate the page at the new
location and update a previously shared backup. Public search indexes can
lag, omit results or list copies from other publishers.

In a saved contact, open **Find this contact again**. Choose Google, Bing or
DuckDuckGo to search the quoted ID. Copy a result's card link and use **Verify
new location** on that same contact. The verifier enforces the saved ID and
signature continuity even if the page lists a different name or address.
Publishing and querying are voluntary. The contact list itself stays local.

Indexing is at each provider’s discretion. [Google Search technical requirements](https://developers.google.com/search/docs/essentials/technical)
