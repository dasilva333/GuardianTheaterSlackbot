/* Define Libraries */
var fs = require("fs");
var _ = require("lodash");
var request = require('request');
var slack = require("slack-notify");
var moment = require("moment");
var destiny = require("destiny-client").default("5cae9cdee67a42848025223b4e61f929");

/* Define Variables */
var configFile = ".\\config.json";
/* This endpoint provides all the clips for a user given the activity id */
var guardianTheaterApiEndpoint = "http://guardian.theater/api/GetClipsPlayerActivity/";
/* 10 Minute Cache on Guardian.Theater data */
var guardianTheaterTTL = 10;

var config = JSON.parse(fs.readFileSync(configFile));
config.XboxGamerTags = _.map(config.XboxGamerTags, function(gt){ return gt.toLowerCase(); });
var serverStartTime = moment();
var accounts = [];
var activitiesMonitored = [];
var gamerTagsMonitored = [];

slack = slack(config.SlackWebhook);

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
            } else {
                console.log("Invalid Xbox Gamertag Provided", gamerTag);
            }
        })
    });
}

function delayedQueryHistory(){
    setTimeout(queryActivityHistory, (guardianTheaterTTL / 2) * 60 * 1000);
}

function queryActivityHistory(){
    console.log("queryActivityHistory");
    carnageCount = 0;
    _.each(accounts, function(account){
        var count = 0;
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
                    count++;
                    /* Eligble activities are defined as any match played in the last 20 minutes (twice the TTL cache time) */
                    var eligbleActivities = _.map(_.filter(res.activities, function(activity){
                        return serverStartTime.diff(moment(activity.period),'minutes') <= (guardianTheaterTTL * 6);
                    }), function(activity){
                        return activity.activityDetails.instanceId;
                    });
                    activitiesMonitored = activitiesMonitored.concat(eligbleActivities);
                    if ( count == account.characters.length ){
                        carnageCount++;
                        if ( carnageCount == accounts.length ){
                            queryActivityCarnage();
                        }                        
                    }
                });
        });
    });
}

function queryActivityCarnage(){
    console.log("queryActivityCarnage");
    activitiesMonitored = _.map(_.uniq(activitiesMonitored), function(activityId){
        return {
            activityId: activityId,
            gamerTags: []
        }
    });
    if ( activitiesMonitored.length == 0 ){
        console.log("no activities found, waiting...");
        delayedQueryHistory();
    } else {
        var activityCount = 0;
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
                    if ( activitiesMonitored.length == activityCount ){
                        queryGameClips();
                    }
                });
        });        
    }
}

/* At this point we have an activity object, each object has an id for the activity and the gamerTags in the activity,
   All that's left is to pass this info to Guardian.theater and figure out if any players recorded any clips for that activity 
*/
function queryGameClips(){
    console.log("queryGameClips");
    var activitiesCount = 1, activeActivities = _.clone(activitiesMonitored);
    function nextActivity(){
        var activity = activeActivities.pop();
        var gamerTagCount = 0;
        console.log(activity.activityId," found activity for ", _.intersection(_.map(activity.gamerTags, function(r){ return r.toLowerCase(); }), config.XboxGamerTags));
        _.each(activity.gamerTags, function(gamerTag){
            var guardianTheaterURL = guardianTheaterApiEndpoint + gamerTag + "/" + activity.activityId;
            request(guardianTheaterURL, function (error, response, body) {
                gamerTagCount++;
                if (!error && response.statusCode == 200) {
                    var clips = JSON.parse(body);
                    if (clips.length){
                        _.each(clips, function(clip){
                            var clipUrl = clip.gameClipUris[0].uri;
                            var description = 'Game Clip by ' + gamerTag + ' recorded ' + moment(clip.dateRecorded).fromNow();
                            slack.send({
                              text: description,
                              attachments: [
                                {
                                  title: "Watch Now",
                                  title_link: clipUrl,
                                  image_url: clip.thumbnails[0].uri,
                                  thumb_url: clip.thumbnails[1].uri,                                                                    
                                  fallback: description,
                                  color: 'good',
                                  fields: [
                                    { title: 'GamerTag', value: gamerTag, short: true },
                                    { title: 'Record At', value: moment(clip.dateRecorded).format('MMMM Do, h:mm a'), short: true }
                                  ]
                                }
                              ]
                            });
                            console.log("notification sent to slack for " + gamerTag);
                        });
                    }
                }
                //console.log(activity.gamerTags.length, gamerTagCount, activity.gamerTags.length == gamerTagCount);
                //console.log("finish", activitiesCount, activitiesMonitored.length);
                if ( activitiesCount == activitiesMonitored.length && activity.gamerTags.length == gamerTagCount ){
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

queryAccountsInfo(function(){
   queryActivityHistory();
});