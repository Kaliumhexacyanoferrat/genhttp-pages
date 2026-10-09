// What people build beside a static site: what they would ask for in the
// editor's Change section, the parts of GenHTTP it takes, and a demo that does
// something like it where the platform has one.

export const USES = {
  game: {
    prompt: "Add multiplayer to my browser game: players in the same room see each other's moves the moment they make them, and the server checks every move.",
    modules: ['websockets', 'rest', 'database'],
    demo: ['https://demo-game.genhttp.run/', 'Play a game built like this']
  },
  chat: {
    prompt: 'Add a chat to my site: messages appear for everybody at once, nicknames are unique per room, and the last hundred messages are kept for whoever joins later.',
    modules: ['websockets', 'database'],
    demo: ['https://demo-game.genhttp.run/', 'See a websocket at work']
  },
  poll: {
    prompt: 'Add a poll to my talk page whose bars move for everyone the moment someone votes, one vote per visitor.',
    modules: ['sse', 'rest', 'database'],
    demo: ['https://demo-live.genhttp.run/', 'Vote in a poll built like this']
  },
  signups: {
    prompt: 'Add an API at api/signups that stores the e-mail addresses my newsletter form posts, each once, and answers with how many there are.',
    modules: ['rest', 'database'],
    demo: ['#change-full', 'See what came back for this one, below'],
    local: true
  },
  comments: {
    prompt: 'Let visitors comment under each blog post. New comments wait until I approve them with a password only I know.',
    modules: ['rest', 'database', 'auth', 'secrets'],
    demo: ['https://demo-crud.genhttp.run/', 'Try records kept like this']
  },
  members: {
    prompt: 'Let people register and sign in, and show the pages below members/ only to them.',
    modules: ['auth', 'database', 'secrets', 'rest'],
    demo: ['https://demo-registration.genhttp.run/', 'Register on a site built like this']
  },
  uploads: {
    prompt: 'Let visitors upload pictures to a shared gallery on my site, up to 5 MB each, and let them delete their own.',
    modules: ['rest', 'files', 'database'],
    demo: ['https://demo-files.genhttp.run/', 'Upload to a gallery built like this']
  },
  proxy: {
    prompt: 'Show the weather for Bern on my start page, from the OpenWeather API, without putting my API key into the page. Ask it at most every ten minutes.',
    modules: ['http', 'secrets', 'caching', 'rest'],
    demo: null
  }
};
