/* Define Libraries */
var fs = require("fs");
var _ = require("lodash");
var request = require('request');
var slack = require("slack-notify");
var moment = require("moment");
var destiny = require("destiny-client").default("5cae9cdee67a42848025223b4e61f929");

/* Define Variables */
var configFile = ".\\config.json";
var guardianTheaterApiEndpoint = "http://guardian.theater/api/GetClipsPlayerActivity/";
var config = JSON.parse(fs.readFileSync(configFile));
slack = slack(config.SlackWebhook);
/* 10 Minute Cache on Guardian.Theater data */
var guardianTheaterTTL = 10;
var serverStartTime = moment();
var accounts = [];
var activitiesMonitored = [];
var gamerTagsMonitored = [];

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
                throw Error("Invalid Xbox Gamertag Provided");
            }
        })
    });
}

function queryActivityHistory(cb){
    console.log("queryActivityHistory");
    carnageCount = 0;
    _.each(accounts, function(account){
        var count = 0;
        _.each(account.characters, function(characterId){
            destiny
                .ActivityHistory({
                    membershipType: account.membershipType,
                    membershipId: account.membershipId,
                    characterId: characterId,
                    mode: "AllPVP"
                })
                .then(res => { 
                    count++;
                    var eligbleActivities = _.map(_.filter(res.activities, function(activity){
                        return serverStartTime.diff(moment(activity.period),'minutes') <= 500;
                    }), function(activity){
                        return activity.activityDetails.instanceId;
                    });
                    activitiesMonitored = activitiesMonitored.concat(eligbleActivities);
                    if ( count == account.characters.length ){
                        carnageCount++;
                        if ( carnageCount == accounts.length ){
                            queryActivityCarnage(cb);
                        }                        
                    }
                });
        });
    });
}

function queryActivityCarnage(cb){
    console.log("queryActivityCarnage");
    activitiesMonitored = _.map(_.uniq(activitiesMonitored), function(activityId){
        return {
            activityId: activityId,
            gamerTags: []
        }
    });
    var activityCount = 0;
     _.each(activitiesMonitored, function(activity){
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
                    queryGameClips(cb);
                }
            });
    });    
}

function queryGameClips(cb){
    console.log("queryGameClips");
    var activitiesCount = 1, activeActivities = _.clone(activitiesMonitored);
    function nextActivity(){
        var activity = activeActivities.pop();
        var gamerTagCount = 0;
        console.log("new activity", gamerTagCount);
        _.each(activity.gamerTags, function(gamerTag){
            var guardianTheaterURL = guardianTheaterApiEndpoint + gamerTag + "/" + activity.activityId;
            request(guardianTheaterURL, function (error, response, body) {
                //console.log(guardianTheaterURL);
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
                console.log("finish", activitiesCount, activitiesMonitored.length);
                if ( activitiesCount == activitiesMonitored.length && activity.gamerTags.length == gamerTagCount ){
                    console.log("cb");
                    cb();        
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
   queryActivityHistory(function(){
        setTimeout(queryActivityHistory, guardianTheaterTTL * 60 * 1000);
   });
});