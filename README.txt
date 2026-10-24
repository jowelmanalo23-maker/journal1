1. Deploy this whole folder as a Netlify site (public/index.html = the journal app, netlify/functions/journal.mjs = the API, netlify.toml and package.json). Drag-and-drop does not build functions: use Git or the Netlify CLI (netlify deploy --prod).
2. Netlify > Site settings > Environment variables: add JOURNAL_KEY = a long random secret. Redeploy.
3. MT5: Tools > Options > Expert Advisors > Allow WebRequest, add https://YOURSITE.netlify.app
4. EA inputs: JournalURL = https://YOURSITE.netlify.app/api/journal   JournalKey = the same secret
5. Your web app reads trades with:
   fetch("/api/journal", { headers: { "x-api-key": KEY } }).then(r => r.json())   // { trades: [...] }
   (Keep the key on the server side / a Netlify function if the page is public.)
