/* Define Libraries */
var fs = require("fs");
var _ = require("lodash");
var request = require('request');
var slack = require("slack-notify");
var moment = require("moment");
var destiny = require("destiny-client")("5cae9cdee67a42848025223b4e61f929");
var randomColor = require("randomcolor");
var async = require("async");
/* Define Variables */
var definitionsFile = "./definitions.js";
var configFile = "config.json";
var notifiedFilePath = "notified.json";
/* This endpoint provides all the clips for a user given the activity id */
var guardianTheaterApiEndpoint = "http://guardian.theater/api/GetClipsPlayerActivity/";
/* 10 Minute Cache on Guardian.Theater data */
var guardianTheaterTTL = 10;
/* A delay factor of 1 means the end point will be queried at the same interval at the cache timer, 2 means twice as fast */
var defaultDelayFactor = 1;
/* Keep track of a timestamp that refers to when a clip was last recorded */
var gameClipLastRecorded;
var config = JSON.parse(fs.readFileSync(configFile));
var definitions = require(definitionsFile);

function saveConfig(){
    fs.writeFileSync(configFile, JSON.stringify(config, null, 4));
}
config.XboxGamerTags = _.map(config.XboxGamerTags, function(gt){ return gt.toLowerCase(); });
if ( !_.has(config,'colors') ){
    config.colors = {};
}
config.colors = _.fromPairs(_.map(config.XboxGamerTags, function(gamerTag){
    var color = _.has(config.colors,gamerTag) ? config.colors[gamerTag] : randomColor({ luminosity: "bright", format: "hex" });
    return [ gamerTag, color ];
}));
saveConfig();
var accounts = [];
var activitiesMonitored = {};
var gamerTagsMonitored = [];
var clipsNotified = [];
if (fs.existsSync(notifiedFilePath)){
	clipsNotified = JSON.parse(fs.readFileSync(notifiedFilePath));
}
slack = slack(config.SlackWebhook);

var addErrorSource = function(source, error){
    if ( error ){
        error = source + ": " + error.toString();
    }
    return error;
};

var tasks = {
    queryAccountsInfo: function(next){
        async.map(config.XboxGamerTags, function(gamerTag, callback){
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
                            callback(null, account);
                        })
                        .catch(function(e){
                            callback(addErrorSource("Account",e), null);
                        });
                } else {
                    callback("users.length, invalid account", null);
                }
            })
            .catch(function(e){
                callback(addErrorSource("Search:",e), null);
            });
        }, function(err, results){
            console.log("finished running all accounts");
            next(addErrorSource("async.map(config.XboxGamerTags",err), results);
        });
    },
    queryActivityHistory: [ 'queryAccountsInfo', function(results, next){
        //console.log("accounts", accounts);
        async.concat(results.queryAccountsInfo, function(account, nextAccount){
            //console.log("account", account);
            async.concat(account.characters, function(characterId, nextCharacter){
                /* This query provides all the activityIds within a given time frame */
                //console.log("checking history for " + account.displayName + "'s characterId: " + characterId);
                var activities = [];
                destiny
                    .ActivityHistory({
                        membershipType: account.membershipType,
                        membershipId: account.membershipId,
                        characterId: characterId,
                        mode: "None"
                    })
                    .then(res => {
                        if ( _.isObject(res) ){
                            var newActivities = _.filter(_.map(res.activities, function(activity){                            
                                var activityId = activity.activityDetails.instanceId;
                                return {
                                    activityId: activityId,
                                    mapId: activity.activityDetails.referenceId,
                                    diffMins: moment().diff(moment(activity.period),'minutes'),
                                    gamerTags: []
                                };
                            }), function(activity){
                                /* Eligble activities are defined as any match played in the last 20 minutes of current activity */
                                return activity.diffMins <= 20;
                            });
                            activities = activities.concat(newActivities);
                            nextCharacter(null, activities);                        
                        } else {
                            nextCharacter(addErrorSource("_.isObject(res) ",res), activities);
                        }
                    })
                    .catch(function(e){
                        nextCharacter(addErrorSource("ActivityHistory",e), null);
                    });
            }, function(err, activities){
                console.log(account.displayName, "activities found for", activities.length);
                nextAccount(addErrorSource("async.concat(account.characters",err), activities);
            });        
        }, function(err, results){
            /* remove duplicae activities where buddies played together */
            var activities = _.uniqBy(results, function(activity){
                return activity.activityId + " " + activity.mapId;
            });
            console.log("finished running all activities", activities.length);
            next(addErrorSource("queryActivityHistory",err), activities);
        });        
    } ],
    queryActivityCarnage: [ 'queryAccountsInfo', 'queryActivityHistory', function(results, next){
        var activities = results.queryActivityHistory;
        async.map(activities, function(activity, nextActivity){
            destiny
                .CarnageReport({
                    activityId: activity.activityId
                })
                .then(res => {
                    activity.gamerTags = _.map(res.entries, function(e){
                        return e.player.destinyUserInfo.displayName;
                    });
                    nextActivity(null, activity);
                })
				.catch(function(e){
					nextActivity(addErrorSource("CarnageReport",e), null);
				});
        }, function(err, results){
            console.log("finished running all pgcr reports", activities.length);
            next(addErrorSource("queryActivityCarnage",err), results);
        });
    } ],
    queryGameClips: [ 'queryAccountsInfo', 'queryActivityHistory', 'queryActivityCarnage', function(results, next){
        var activities = results.queryActivityCarnage;
		async.concat(activities, function(activity, nextActivity){
            async.concat(activity.gamerTags, function(gamerTag, nextGT){
                var notifications = [];
                var guardianTheaterURL = guardianTheaterApiEndpoint + gamerTag + "/" + activity.activityId;
				request(guardianTheaterURL, function (error, response, body) {
					if (!error && response.statusCode == 200) {
                        var clips = [];
                        try {
                            clips = JSON.parse(body);
                        } catch(e){
                            return nextGT("JSON.parse" + e, notifications);
                        }						
						if (clips.length){
							notifications = _.map(clips, function(clip){
                                var id = clip.gameClipId;
								if ( clipsNotified.indexOf(id) == -1 ){
                                    return {
                                        id: id,
                                        url: "http://guardian.theater/gamertag/"+ gamerTag + "/clip/" + id,
                                        description: 'Game recording by ' + gamerTag + ' at ' + definitions[activity.mapId].activityName,
                                        date: moment(clip.dateRecorded).format('MMMM Do, h:mm a'),
                                        color: config.XboxGamerTags.indexOf(gamerTag.toLowerCase()) > -1 ? config.colors[gamerTag] : "#0041C2",
                                        image: clip.thumbnails[0].uri,
                                        thumb: clip.thumbnails[1].uri,
                                        recordedBy: gamerTag,
                                        inActivity: _.intersection(_.map(activity.gamerTags, function(r){ return r.toLowerCase(); }), config.XboxGamerTags),
                                    };
                                }
                            });
                        }
                    }
                    nextGT(addErrorSource("request(guardianTheaterURL",error), notifications);
                });                 
            }, function(err, results){
                console.log("clips found for activity", results.length);
                nextActivity(addErrorSource("activity.gamerTags",err), results);
            });
        }, function(err, results){
            var clips = _.compact(results);
            console.log("finished running all gameclips to notify", clips.length);
            next(addErrorSource("async.concat(activities",err), clips);
        });
    } ],
    notifySlack: [ 'queryGameClips', function(results, next){
        var notifications = results.queryGameClips;
        console.log("notifications", notifications)
        _.each(notifications, function(notification){
            console.log("notification", notification)
            slack.send({
                text: notification.description,
                icon_url: "http://guardian.theater/public/images/travelereel.png",
                username: "GuardianTheaterBot",
                attachments: [
                {
                    title: "Watch Now",
                    title_link: notification.url,
                    image_url: notification.image,
                    thumb_url: notification.thumb,                                                                    
                    fallback: notification.description,
                    color: notification.color,
                    fields: [
                        { title: 'Recorded By', value: notification.recordedBy, short: true },
                        { title: 'In Activity', value: notification.inActivity.join(", "), short: true },
                        { title: 'Record At', value: notification.date, short: true }
                    ]
                }
                ]
            }, function(err){
                if (!err){
                    clipsNotified.push(notification.id);
                    fs.writeFileSync(notifiedFilePath, JSON.stringify(clipsNotified));
                }
            });
        });
        next(null, []);
    } ]
};

var cycles = 0, delayFactor = defaultDelayFactor;
async.forever(
    function(next) {
        // next is suitable for passing to things that need a callback(err [, whatever]);
        // it will result in this function being called again.
        console.log("starting GuardianTheaterBot server");        
        async.auto(tasks, function(err, results){     
            /* When a clip is detected, set the delay factor to 2x (every 5 mins) for 10 cycles, if no video is detected in 60 mins, defaultDelayFactor (1x 10 mins) will return */
            if ( results.queryGameClips.length > 0 ){
                cycles = 0;
                delayFactor = 2;
            }             
            else if (cycles == 12){
                delayFactor = defaultDelayFactor;
            }
            cycles++;
            var delay = (guardianTheaterTTL / delayFactor) * 60 * 1000;
            console.log("tasks completed, waiting for ", delay, "ms (", (delay / 60 / 1000), " minutes)");
            setTimeout(function(){
                next("next:" + err);
            }, delay);
        });
    },
    function(err) {
        // if next is called with a value in its first parameter, it will appear
        // in here as 'err', and execution will stop.
        console.log("async.forever:", err);
    }
);


