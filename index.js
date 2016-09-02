/* Define Libraries */
var fs = require("fs");
var _ = require("lodash");
var request = require('request');
var slack = require("slack-notify");
var moment = require("moment");
var destiny = require("destiny-client").default("5cae9cdee67a42848025223b4e61f929");

/* Define Variables */
var configFile = "config.json";
var notifiedFilePath = "notified.json";
/* This endpoint provides all the clips for a user given the activity id */
var guardianTheaterApiEndpoint = "http://guardian.theater/api/GetClipsPlayerActivity/";
/* 10 Minute Cache on Guardian.Theater data */
var guardianTheaterTTL = 10;

var config = JSON.parse(fs.readFileSync(configFile));
config.XboxGamerTags = _.map(config.XboxGamerTags, function(gt){ return gt.toLowerCase(); });
var serverStartTime = moment();
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
                        if ( config.XboxGamerTags.length == accounts.length ){ cb(); }
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

function delayedQueryHistory(){
	var delay = (guardianTheaterTTL / 2) * 60 * 1000;
	console.log("waiting for delayedQueryHistory", delay);	
    setTimeout(function(){
		console.log("next queryActivityHistory");
		queryActivityHistory();
	}, delay);
}

function queryActivityHistory(){
	var accountIndex = 0;
	function getNextCharacterHistory(){
		var count = 0;
		var account = accounts[accountIndex];
		accountIndex++;
        _.each(account.characters, function(characterId){
            /* This query provides all the activityIds within a given time frame */
            console.log("checking history for " + account.displayName + "'s characterId: " + characterId);
            destiny
                .ActivityHistory({
                    membershipType: account.membershipType,
                    membershipId: account.membershipId,
                    characterId: characterId,
                    mode: "AllPVP"
                })
                .then(res => { 
                    //count++;
					//console.log("activityhistory", count);
                    /* Eligble activities are defined as any match played 20 minutes before the server was started */
                    _.each(_.filter(res.activities, function(activity){
						var diffMins = serverStartTime.diff(moment(activity.period),'minutes');
                        return diffMins <= 20;
                    }), function(activity){
						var activityId = activity.activityDetails.instanceId;
                        activitiesMonitored[activityId] = {
							activityId: activityId,
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
    console.log("queryActivityCarnage");
    if ( _.keys(activitiesMonitored).length == 0 ){
        console.log("no activities found, waiting...");
        delayedQueryHistory();
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
	//console.log("activeActivities", activeActivities)
    function nextActivity(){
        var activity = activeActivities.pop();
		//console.log("activity", activity)
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
								var clipUrl = clip.gameClipUris[0].uri;
								clipsNotified.push(clip.gameClipId);
								fs.writeFileSync(notifiedFilePath, JSON.stringify(clipsNotified));
								var description = 'Game Clip by ' + gamerTag + ' recorded ' + moment(clip.dateRecorded).fromNow();
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
										{ title: 'Record At', value: moment(clip.dateRecorded).format('MMMM Do, h:mm a'), short: true }
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
                //console.log("nextActivity", activity.gamerTags.length, gamerTagCount, activity.gamerTags.length == gamerTagCount);
                //console.log("delayedQueryHistory", activitiesCount, _.keys(activitiesMonitored).length, activitiesCount == _.keys(activitiesMonitored).length);
                if ( activitiesCount == _.keys(activitiesMonitored).length && activity.gamerTags.length == gamerTagCount ){
                    /* Check every 5 minutes instead of 10 to account for any timing mismatch */
                    console.log("waiting 5 minutes to check history again");
                    delayedQueryHistory();
                }
                else if ( activity.gamerTags.length == gamerTagCount ){
                    activitiesCount++;
                    nextActivity();
                }
            });        
        }); 
    }
    nextActivity();
}

/* start the monitoring process */
queryAccountsInfo(function(){
   queryActivityHistory();
});