export const commands = [
  {
    name: "pbem-nodb",
    description: "Create a game board without using the database",
    options: [
      {
        type: 3,
        name: "name",
        description: "The name of the game",
        min_length: 1,
        max_length: 80,
        required: true,
      },
      {
        type: 3,
        name: "mode",
        description: "How the game's turns work",
        required: true,
        choices: [
          { name: "Consecutive", value: "consecutive" },
          { name: "Simultaneous", value: "simultaneous" },
          { name: "Both (switchable)", value: "both" },
        ],
      },
    ],
  },
  {
    name: "pbem",
    description: "Create a play-by-email game",
    options: [
      {
        type: 3,
        name: "name",
        description: "The name of the game",
        min_length: 1,
        max_length: 80,
        required: true,
      },
      {
        type: 3,
        name: "mode",
        description: "How the game's turns work",
        required: true,
        choices: [
          { name: "Consecutive", value: "consecutive" },
          { name: "Simultaneous", value: "simultaneous" },
          { name: "Both (switchable)", value: "both" },
        ],
      },
      {
        type: 4,
        name: "reminder-days",
        description: "Days a player can be pending before one private reminder (0 disables reminders)",
        min_value: 0,
        max_value: 365,
        required: false,
      },
    ],
  },
  {
    name: "pbem-teams",
    description: "Add or remove shared-player teams from an active game",
    options: [
      {
        type: 3,
        name: "game",
        description: "Choose an active game in this server",
        min_length: 1,
        max_length: 80,
        required: true,
        autocomplete: true,
      },
      {
        type: 3,
        name: "action",
        description: "Add a shared-player team or remove one",
        required: true,
        choices: [
          { name: "Add team", value: "add" },
          { name: "Remove team", value: "remove" },
        ],
      },
    ],
  },
  {
    name: "pbem-players",
    description: "Add or remove players from an active game",
    options: [
      {
        type: 3,
        name: "game",
        description: "Choose an active game in this server",
        min_length: 1,
        max_length: 80,
        required: true,
        autocomplete: true,
      },
      {
        type: 3,
        name: "action",
        description: "Add players or remove players from the game",
        required: true,
        choices: [
          { name: "Add players", value: "add" },
          { name: "Remove players", value: "remove" },
        ],
      },
    ],
  },
  {
    name: "pbem-remind",
    description: "Manually remind pending players for a game in this server",
    options: [
      {
        type: 3,
        name: "game",
        description: "Choose an active game in this server",
        min_length: 1,
        max_length: 80,
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "pbem-reminders",
    description: "Set automated reminder days for a game",
    options: [
      {
        type: 3,
        name: "game",
        description: "Choose an active game in this server",
        min_length: 1,
        max_length: 80,
        required: true,
        autocomplete: true,
      },
      {
        type: 4,
        name: "days",
        description: "Pending days before a reminder (0 disables reminders)",
        min_value: 0,
        max_value: 365,
        required: true,
      },
    ],
  },
  {
    name: "pbem-delete",
    description: "Delete a game and its status board",
    options: [
      {
        type: 3,
        name: "game",
        description: "Choose an active game in this server",
        min_length: 1,
        max_length: 80,
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "pbem-status",
    description: "Privately view the status of a game",
    options: [
      {
        type: 3,
        name: "game",
        description: "Choose an active game in this server",
        min_length: 1,
        max_length: 80,
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "pbem-away",
    description: "Mark a player as away in every game they are in on this server",
    options: [
      {
        type: 6,
        name: "player",
        description: "Who is away (defaults to you)",
        required: false,
      },
      {
        type: 3,
        name: "until",
        description: "Return date as YYYY-MM-DD (leave empty for no return date)",
        min_length: 10,
        max_length: 10,
        required: false,
      },
    ],
  },
  {
    name: "pbem-back",
    description: "Clear a player's away status on this server",
    options: [
      {
        type: 6,
        name: "player",
        description: "Who is back (defaults to you)",
        required: false,
      },
    ],
  },
  {
    name: "pbem-gameover",
    description: "Finish a game, record the winner, and archive its stats",
    options: [
      {
        type: 3,
        name: "game",
        description: "Choose an active game in this server",
        min_length: 1,
        max_length: 80,
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "pbem-list",
    description: "List PBEM games in this server",
  },
  {
    name: "pbem-delete-all",
    description: "Delete all PBEM games in this server",
  },
];
