/* Define Libraries */
var fs = require("fs");
var _ = require("lodash");
var request = require('request');
var slack = require("slack-notify");
var moment = require("moment");
var destiny = require("destiny-client")("5cae9cdee67a42848025223b4e61f929");
var express = require("express");
/* Define Variables */
var definitionsFile = "./definitions.js";
var configFile = "config.json";
var notifiedFilePath = "notified.json";
/* This endpoint provides all the clips for a user given the activity id */
var guardianTheaterApiEndpoint = "http://guardian.theater/api/GetClipsPlayerActivity/";
/* 10 Minute Cache on Guardian.Theater data */
var guardianTheaterTTL = 10;
/* A delay factor of 1 means the end point will be queried at the same interval at the cache timer, 2 means twice as fast */
var delayFactor = 1;
/* Keep track of a timestamp that refers to when a clip was last recorded */
var gameClipLastRecorded;
var config = JSON.parse(fs.readFileSync(configFile));
var definitions = require(definitionsFile);

config.XboxGamerTags = _.map(config.XboxGamerTags, function(gt){ return gt.toLowerCase(); });
var accounts = [];
var activitiesMonitored = {};
var gamerTagsMonitored = [];
var clipsNotified = [];
if (fs.existsSync(notifiedFilePath)){
	clipsNotified = JSON.parse(fs.readFileSync(notifiedFilePath));
}
slack = slack(config.SlackWebhook);

/* Define Functions */
function queryAccountsInfo(cb){
    console.log("queryAccountsInfo");
    accounts = [];
    _.each(config.XboxGamerTags, function(gamerTag){
        destiny
          .Search({
            membershipType: 1,
            name: gamerTag
          })
          .then(function(users){
            if (users.length == 1){
                var account = _.first(users);
                destiny
                    .Account({
                        membershipType: 1,
                        membershipId: account.membershipId
                    })
                    .then(res => { 
                        account.characters = _.map(res.characters, function(c){
                            return c.characterBase.characterId;
                        });
                        accounts.push(account);
                        if ( config.XboxGamerTags.length == accounts.length ){ if (cb) cb(); }
                    })
					.catch(function(){
						console.log("error:", e);
					});
            } else {
                console.log("Invalid Xbox Gamertag Provided", gamerTag);
            }
        })
		.catch(function(){
			console.log("error:", e);
		});
    });
}

function queryActivityHistory(){
	var accountIndex = 0;
	function getNextCharacterHistory(){
		var count = 0;
		var account = accounts[accountIndex];
		accountIndex++;
        _.each(account.characters, function(characterId){
            /* This query provides all the activityIds within a given time frame */
            //console.log("checking history for " + account.displayName + "'s characterId: " + characterId);
            destiny
                .ActivityHistory({
                    membershipType: account.membershipType,
                    membershipId: account.membershipId,
                    characterId: characterId,
                    mode: "None"
                })
                .then(res => { 
                    //count++;
					//console.log("activityhistory", count);
                    /* Eligble activities are defined as any match played in the last 20 minutes of current activity */
                    _.each(_.filter(res.activities, function(activity){
						var diffMins = moment().diff(moment(activity.period),'minutes');
                        return diffMins <= 20;
                    }), function(activity){
						var activityId = activity.activityDetails.instanceId;
                        activitiesMonitored[activityId] = {
							activityId: activityId,
                            mapId: activity.activityDetails.referenceId,
							gamerTags: []
						};
                    });                    
					//console.log("activityhistory", characterId, count == account.characters.length);
                    /*if ( count == account.characters.length ){
                        carnageCount++;
						console.log("carnageCount", carnageCount, accounts.length)
                        if ( carnageCount == accounts.length ){
							console.log("ready to run queryActivityCarnage")
                            queryActivityCarnage();
                        }                        
                    }*/
					if (accountIndex > accounts.length){
						queryActivityCarnage();
					} else {
						getNextCharacterHistory();
					}
                })
				.catch(function(){
					console.log("error:", e);
				});
        });
	}
    console.log("queryActivityHistory");
    //carnageCount = 0;
	getNextCharacterHistory();
}

function queryActivityCarnage(){
    //console.log("queryActivityCarnage");
    if ( _.keys(activitiesMonitored).length == 0 ){
        //console.log("no activities found, waiting...");
        //delayedQueryHistory();
    } else {
        var activityCount = 0;
		//console.log("activitiesMonitored", activitiesMonitored);
         _.each(activitiesMonitored, function(activity){
            /* This query provides the information as to who was playing in a given activityId */
            destiny
                .CarnageReport({
                    activityId: activity.activityId
                })
                .then(res => {
                    activityCount++;
                    activity.gamerTags = _.map(res.entries, function(e){
                        return e.player.destinyUserInfo.displayName;
                    });
                    if ( _.keys(activitiesMonitored).length == activityCount ){
                        queryGameClips();
                    }
                })
				.catch(function(){
					console.log("error:", e);
				});
        });        
    }
}

/* At this point we have an activity object, each object has an id for the activity and the gamerTags in the activity,
   All that's left is to pass this info to Guardian.theater and figure out if any players recorded any clips for that activity 
*/
function queryGameClips(){
    console.log("queryGameClips");
    var activitiesCount = 1, activeActivities = _.map(activitiesMonitored);
	function finish(activity){
		//console.log("nextActivity", activity.gamerTags.length, gamerTagCount, activity.gamerTags.length == gamerTagCount);
		//console.log("delayedQueryHistory", activitiesCount, _.keys(activitiesMonitored).length, activitiesCount == _.keys(activitiesMonitored).length);
		if ( activitiesCount == _.keys(activitiesMonitored).length && activity.gamerTags.length == gamerTagCount ){
			/* Check every 5 minutes instead of 10 to account for any timing mismatch */
			console.log("waiting 5 minutes to check history again");
			//delayedQueryHistory();
		}
		else if ( activity.gamerTags.length == gamerTagCount ){
			activitiesCount++;
			nextActivity();
		}
	}
	//console.log("activeActivities", activeActivities)
    function nextActivity(){
        var activity = activeActivities.pop();
		//console.log("activity", activity)
		if ( activity && activity.gamerTags ){
			activity.intersection = _.intersection(_.map(activity.gamerTags, function(r){ return r.toLowerCase(); }), config.XboxGamerTags);
			var gamerTagCount = 0;
			//console.log(activity.activityId," found activity for ", activity.intersection);
			if ( activity.gamerTags.length == 0 ){
				console.log("weird activity", activity)
			}
			_.each(activity.gamerTags, function(gamerTag){
				//console.log("gamerTag", gamerTag)
				var guardianTheaterURL = guardianTheaterApiEndpoint + gamerTag + "/" + activity.activityId;
				console.log("guardianTheaterURL", guardianTheaterURL)
				request(guardianTheaterURL, function (error, response, body) {
					gamerTagCount++;
					//console.log("gamerTagCount", gamerTagCount)
					if (!error && response.statusCode == 200) {
						var clips = JSON.parse(body);
						if (clips.length){
							_.each(clips, function(clip){
								if ( clipsNotified.indexOf(clip.gameClipId) == -1 ){
									var clipUrl = "http://guardian.theater/gamertag/"+ gamerTag + "/clip/" + clip.gameClipId;
									clipsNotified.push(clip.gameClipId);
									fs.writeFileSync(notifiedFilePath, JSON.stringify(clipsNotified));
									var description = 'Game recording by ' + gamerTag + ' at ' + definitions[activity.mapId].activityName;
									var gameClipRecordAt = moment(clip.dateRecorded);
									gameClipLastRecorded = gameClipRecordAt;
									slack.send({
									  text: description,
									  icon_url: "http://guardian.theater/public/images/travelereel.png",
									  username: "GuardianTheaterBot",							  
									  attachments: [
										{
										  title: "Watch Now",
										  title_link: clipUrl,
										  image_url: clip.thumbnails[0].uri,
										  thumb_url: clip.thumbnails[1].uri,                                                                    
										  fallback: description,
										  color: 'good',
										  fields: [
											{ title: 'Recorded By', value: gamerTag, short: true },
											{ title: 'In Activity', value: activity.intersection.join(", "), short: true },
											{ title: 'Record At', value: gameClipRecordAt.format('MMMM Do, h:mm a'), short: true }
										  ]
										}
									  ]
									});
									console.log("notification sent to slack for " + gamerTag);								
								} else {
									console.log("skipping video already notified")
								}
							});
						}
					}
					finish(activity);
				});        
			}); 
		} else {
			finish(activity);
		}
    }
    nextActivity();
}

var monitorGameClips = function(){
    /* The delay is set to half the cache time to ensure that the bot remains responsive and in sync during use and reverts back to full cache time wait during off time */
	if ( gameClipLastRecorded && moment().diff(gameClipLastRecorded,'minutes') < 60 ){
        delayFactor = 2
    } else {
        delayFactor = 1;
    }
    var delay = (guardianTheaterTTL / delayFactor) * 60 * 1000;
	console.log("waiting for delayedQueryHistory", delay, (delay / 60 / 1000), "minutes");	
    setTimeout(function(){
		console.log("next queryActivityHistory");
		queryActivityHistory();
        monitorGameClips();
	}, delay);
}

/* start the monitoring process */
queryAccountsInfo(function(){
    monitorGameClips();
    queryActivityHistory();
});

var app = express();

app.get('/listgamers', function (req, res) {
  res.send("GuardianBot is currently configured to monitor " + config.XboxGamerTags.join(", "));
});

app.get('/addgamer/*', function (req, res) {
  var gamertag = req.params[0].toLowerCase();
  if ( gamertag ){  
      var index = config.XboxGamerTags.indexOf(gamertag);
      if ( index > -1 ){
          res.send("Gamer already part of the list; " + config.XboxGamerTags.join(", "));
      } else {
          config.XboxGamerTags.push(gamertag);
          queryAccountsInfo();
          fs.writeFileSync(configFile, JSON.stringify(config));
          res.send("GuardianBot added " + gamertag + " to the list of monitored accounts; " + config.XboxGamerTags.join(", "));
      }     
  } else {
    res.send(500);
  }
});

app.get('/removegamer/*', function (req, res) {
  var gamertag = req.params[0].toLowerCase();
  if ( gamertag ){  
      var index = config.XboxGamerTags.indexOf(gamertag);
      if ( index > -1 ){
          config.XboxGamerTags.splice(index, 1)  
          fs.writeFileSync(configFile, JSON.stringify(config, null, 4));
          res.send("GuardianBot removed " + gamertag + " from the list of monitored accounts; " + config.XboxGamerTags.join(", "));
      } else {
        res.send(500);
      }      
  } else {
    res.send(500);
  }
});

app.listen(1337, function () {
  console.log('GuardianTheaterBot Helper listening on port 1337!');
});