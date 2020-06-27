//////////////////////////////////////////////
////////////// Global Variables //////////////
//////////////////////////////////////////////

const express = require("express");
const app = express();
var http = require("http");
var server = http.createServer(app);
var io = require("socket.io").listen(server);
const axios = require("axios");
var path = require("path");


// Games hold all current games on the server. 
// Each game object contains a "status".
// status=0: Game is in the lobby
// status=1: Game is currently playing
// status=2: Game has ended

var games = new Map();
games.set('0', { status: 0, numPlayers: 0, curRest: null, restaurants: ["Pizza Hut", "Burger King"] }); //TODO: remove after
games.set('1', { status: 0, numPlayers: 0, curRest: null, restaurants: ["Shahs", "Taco Bell", "3", "4"] });

//////////////////////////////////////////////
/////////////////// Config ///////////////////
//////////////////////////////////////////////

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json()) // for parsing application/json
server.listen(3000);
var cors = require('cors');

// use it before all route definitions
app.use(cors({origin: 'http://localhost:8080'})); 
//////////////////////////////////////////////
/////////////// HTTP Functions ///////////////
//////////////////////////////////////////////
app.get("/", (req,resp) => {
  resp.sendFile(__dirname + "/index.html");
});


// To create a new game, make POST request to /newGame, and game will now be in gamesInLobby
app.post("/newGame", (req, resp) => 
{  
  let rand = (Math.random()+1).toString(36).substring(7);
  let restaurants = [];
  
  axios.get(
    "https://api.yelp.com/v3/businesses/search?" +
    "term=" + req.body.searchText +
    "&latitude=" + req.body.latitude +
    "&longitude=" + req.body.longitude +
    "&limit=10",
    {
      headers: {
        Authorization: "Bearer 7h6mE0vGyjIgFRrJvTF5xuru11IELRJ0tLTSTvCprJ706dsage7dot2a3-Ih0QNv9OOZoqtPNVXtery8EziMKKs5_Z3OnUx8vLFBnVOdtHhZ73wGc0KYPfpx4jXxXnYx"
      }
    })
    .then(apiResp => {
      if (apiResp) {
        restaurants = apiResp.data.businesses;
        games.set(rand, { 'status': 0, 'restaurants': restaurants, 'numPlayers': 0 })
        
        // Respond with join code
        resp.send(rand);
      }
    })
    .catch(err => {
      console.log(err);
    });
});

// Method for getting yelp autocomplete
app.get("/autocomplete", (req, resp) => {

  const url = `http://api.yelp.com/v3/autocomplete?text=${req.query.keyword}`
  axios.get(url,
      { 
        headers: {
          Authorization:
            "Bearer 7h6mE0vGyjIgFRrJvTF5xuru11IELRJ0tLTSTvCprJ706dsage7dot2a3-Ih0QNv9OOZoqtPNVXtery8EziMKKs5_Z3OnUx8vLFBnVOdtHhZ73wGc0KYPfpx4jXxXnYx"
        }
      }
  )
  .then(apiResp => {
    //  console.log(apiResp.data.terms)
      resp.send(apiResp.data.terms)
  })
  .catch(err => {
      console.log(err);
  });
});

// Method to get full reviews from yelp
app.get("/reviews", (req, resp) => {
  axios.get(
    "https://api.yelp.com/v3/businesses/" + req.query.id + "/reviews",
    {
      headers: {
          Authorization: "Bearer 7h6mE0vGyjIgFRrJvTF5xuru11IELRJ0tLTSTvCprJ706dsage7dot2a3-Ih0QNv9OOZoqtPNVXtery8EziMKKs5_Z3OnUx8vLFBnVOdtHhZ73wGc0KYPfpx4jXxXnYx"
      }
    }
  )
  .then(apiResp => {
    resp.send(apiResp.data.reviews);
  })
  .catch(err => {
      console.log(err);
      resp.send(err);
  });
  
});

app.get("/checkGame", (req, resp) => {
  
  let game = games.get(req.query.joinCode);
  if (game == undefined) {
    resp.status(404).send("Not Found");
  } else {
    resp.status(200).send("OK");
  }
  
});
//////////////////////////////////////////////
///////////// WebSocket Functions ////////////
//////////////////////////////////////////////

io.sockets.on("connection", function(socket) 
{  
  //console.log(socket.handshake.query["joinCode"]);
  // Emit this event to join a game
  socket.on("joinGame", function() 
  {
    // Grab the game instance
    let joinCode = verifyCode(socket, 0);
    if (joinCode < 0) {
      return;
    }
    let game = games.get(joinCode);
    
    // Add the player to the game lobby
    ++game.numPlayers;
    socket.join(joinCode); 
    io.in(joinCode).emit('joinedGame', {numPlayers: game.numPlayers});
  });
  
  // Emit this event to start the game
  // the player is in the "lobby" for
  socket.on("startGame", function() 
  {
    // Grab the game instance
    let joinCode = verifyCode(socket, 0);
    if (joinCode < 0) {
      return;
    }    
    let game = games.get(joinCode); 

    // Set the game status to playing
    game.status = 1;
    game.round = 0;
    game.numVotes = 0;
    game.votes = [];
    game.votes.push(0);
    games.set(joinCode, game); 
    
    // Let everyone know the game started, and send the 1st restaurant
    getRestaurant(game.restaurants[0].id).then((firstRest) => {
      io.in(joinCode).emit("startedGame", {restaurant: firstRest});     
    });

  });
  
  // Emit this event with a ok=true if 
  //the user selected the restaurant.
  socket.on("submitVote", function(ok) 
  { 
    // Grab the game instance
    let joinCode = verifyCode(socket, 1);
    if (joinCode < 0) {
      return;
    }
    let game = games.get(joinCode);

    // Increment votes
    ++game.numVotes;
    if (ok)
      game.votes[game.round] += 1;
    
    // If everyone voted and ...
    if (game.numVotes % game.numPlayers == 0) {
      debug(game);
      
      // if there was no winner, continue playing
      let winner = checkWin(game);
      if (winner == null) {
        
        // If this restaurant had > 0 votes, add back
        let curRest = game.restaurants.shift();
        if (game.votes[game.round] != 0 ) {
         // console.log("CurRest: " + curRest);
          game.restaurants.push(curRest);
        }
        
        // Prepare the game for the next round
        ++game.round;
        game.votes.push(0);
        
        //console.log(game.restaurants[0].id);
        getRestaurant(game.restaurants[0].id).then((nextRest) => {
          io.in(joinCode).emit("nextChoice", {restaurant: nextRest});     
        });
     
        
      }
      // otherwise, if winner != null, end the game
      else {
        io.in(joinCode).emit("endedGame", winner);
        console.log(winner);
        game.status = 2;
      }
    }
    
  }); 
});

//////////////////////////////////////////////
////////////// Helper Functions //////////////
//////////////////////////////////////////////
function debug(game) 
{   
  console.log("round: "+ game.round);
  console.log("totalVotes: " + game.numVotes);
  console.log("numPlayers: " + game.numPlayers);
  console.log("Votes for " + game.restaurants[0] + ": " + game.votes[game.round]);
}

async function getRestaurant(id) 
{
  return axios.get(
    "https://api.yelp.com/v3/businesses/" + id,
    {
      headers: {
        Authorization: "Bearer 7h6mE0vGyjIgFRrJvTF5xuru11IELRJ0tLTSTvCprJ706dsage7dot2a3-Ih0QNv9OOZoqtPNVXtery8EziMKKs5_Z3OnUx8vLFBnVOdtHhZ73wGc0KYPfpx4jXxXnYx"
      }
    })
    .then(apiResp => {
    if (apiResp) {
     
      return apiResp.data;
    }
  });
  
}

function verifyCode(socket, status) 
{
  let joinCode = socket.handshake.query["joinCode"];
  let game = games.get(joinCode);
 
  // If the game wasn't found
  if (game === undefined) {
    socket.emit("myerror", "Invalid Join Code");
    socket.disconnect();
    return -1;
  } 
  
  // If the game's status code doesn't match
  if (game.status != status) {
    switch(game.status) {
      case 0:
        socket.emit("myerror", "This game is still in the lobby");
        break;
      case 1:
        socket.emit("myerror", "This game has already started");
        break;
      case 2:
        socket.emit("myerror", "This game has ended");
        break;
      default:
        socket.emit("myerror", "idk how you got this error tbh");
        break;
    }
    socket.disconnect();
    return -2;
  }
  return joinCode;
}

function checkWin(game) 
{
  let winner = null;
  
  // If everyone was down for the restaurant, end game
  if (game.votes[game.round] == game.numPlayers) {
    winner = game.restaurants[0];
  }

  // If game has gone on for >= 2 cycles, pick most popular restaurant
  else if (game.numVotes >= game.restaurants.size * 2 ) {
    let winner = game.restaurants.indexOf(Math.max.apply(Math, game.votes));
  }

  // If there are no restaurants left, cause everyone hated them all
  else if (game.restaurants.length == 1) {
      let restaurant = {"name": "You guys are picky af"};
      winner = restaurant;
  }
  
  return winner;
}