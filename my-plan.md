## What is it?

A discord helper that allows a user to create an instance of an app (using slash commands or something better)
The app is to aid a collection of users in maintaining the correct status of a play by email game (uncoupled)
Hosted in vercel. Free tier. Code in this repo. Web page rendered by GitHub pages (see the implementation for other pages in this repo)

## What is the general idea

The app will accept a collection of users. Each user is given a button with either a "pending" or "done" status.

Anyone can click any button.

Above the button, is the collection of @userIds for the collection of users that are pending, so when the state updates, any pending users are notified it's their turn.

## Creating a new app

Each instance of the app allows the user creating it to give it a free text name.

It will also need to decide whether it's simultaneous turns, or consecutive turns. Or both.

- Simultaneous turns waits until everyone is set to done before auto refreshing everyone back to pending - multiple buttons can have the state "pending"
- Consecutive turns means whenever a button is pressed, that button becomes the "pending" player
- If both is chosen, there needs to be a method to switch the logic from consecutive to simultaneous (maybe another button?)

## Thoughts

- There can be multiple active instances of the app running with different names.
- Other slash commands could be used to reprompt the pending users
- Or state how long users have been set to pending for?

A datastore could hold all active instances of the app, who the players are, how long the games have been running etc

Also how long users have been set to pending. This data could be rendered in discord with a slash command, and or visible on a github hosted website (the same was as board-games and ear training)