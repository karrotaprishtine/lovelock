# Lovelock

Lovelock is a romantic real-time dating game app built around one idea: `Play. Win. Unlock.`

Instead of swiping, two players are matched instantly, play a live tic-tac-toe style game using `X` and `heart`, and earn deeper interaction through wins, questions, and earned one-time messages.

## Stack

- React + Vite frontend
- Express + Socket.IO backend
- Local JSON persistence for sessions, answers, and chat history
- Shared content and game constants for both client and server

## Run

1. Install dependencies at the root:

```bash
npm install
```

If PowerShell blocks `npm`, use:

```bash
npm.cmd install
```

2. Start both apps:

```bash
npm run dev
```

Or in PowerShell:

```bash
npm.cmd run dev
```

3. Open the client URL shown by Vite. By default the server runs on `http://localhost:4000`.

## Testing With Another Player

- Same computer: open Lovelock in a second browser, private window, or another tab and join with a different name/gender.
- Same Wi-Fi network: after starting the app, find your PC's IPv4 address with `ipconfig` and open `http://YOUR-IP:5173` on the other phone or laptop.
- Public internet: `localhost` links do not work for other people on the internet. Use a tunnel or deploy the app first.

## Optional Environment

- Client: set `VITE_SOCKET_URL` if your Socket.IO server is not running on `http://localhost:4000`
- Server: set `CLIENT_URL` if your frontend is not running on `http://localhost:5173`

## Free Deployment

This repo is ready for a simple one-service Render deploy:

1. Push the project to GitHub.
2. Create a free Render account.
3. Click `New` -> `Blueprint` and select your GitHub repo.
4. Render will detect [`render.yaml`](./render.yaml) and create the web service.
5. After the first deploy, open the Render service settings and set:

```bash
CLIENT_URL=https://YOUR-SERVICE-NAME.onrender.com
```

6. Redeploy once after adding `CLIENT_URL`.

The backend will serve the built Vite frontend automatically in production, so you only need one Render web service and one public URL.

## Project Structure

- `client` - responsive Lovelock UI
- `server` - matchmaking, gameplay, invite codes, persistence, chat progression
- `shared` - content engine and shared constants

## Notes

- Matching is restricted to male/female pairings as requested.
- Answers are limited to 25 characters.
- Messages are limited to 50 characters.
- Players earn 1 message after every 3 wins, and spending it means earning 3 more wins for the next one.
- Invite codes create private "secret match" sessions.
- The backend stores users, sessions, question history, answers, and chat messages in `server/data/lovelock.json`.
