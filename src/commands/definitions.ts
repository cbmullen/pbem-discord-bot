export const commands = [
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
    ],
  },
  {
    name: "pbem-remind",
    description: "Manually remind pending players in this channel",
    options: [
      {
        type: 3,
        name: "game",
        description: "The game name in this channel",
        min_length: 1,
        max_length: 80,
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
        description: "The game name in this server",
        min_length: 1,
        max_length: 80,
        required: true,
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
