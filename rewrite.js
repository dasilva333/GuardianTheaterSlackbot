/* Define Libraries */
var fs = require("fs");
var _ = require("lodash");
var request = require('request');
var slack = require("slack-notify");
var moment = require("moment");
var destiny = require("destiny-client")("5cae9cdee67a42848025223b4e61f929");
var express = require("express");
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
var defaultDelayFactor = 3;
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

/*
async.forever(
    function(next) {
        // next is suitable for passing to things that need a callback(err [, whatever]);
        // it will result in this function being called again.
        console.log("forever!!");
        setTimeout(next, 2000);
    },
    function(err) {
        // if next is called with a value in its first parameter, it will appear
        // in here as 'err', and execution will stop.
    }
);*/


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
                            callback(e, null);
                        });
                } else {
                    callback("invalid account", null);
                }
            })
            .catch(function(e){
                callback(e, null);
            });
        }, function(err, results){
            console.log("finished running all accounts");
            next(err, results);
        });
    },
    queryActivityHistory: [ 'queryAccountsInfo', function(results, next){
        //console.log("accounts", accounts);
        async.map(results.queryAccountsInfo, function(account, nextAccount){
            //console.log("account", account);
            async.map(account.characters, function(characterId, nextCharacter){
                //console.log("characterId", characterId);
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
                        //count++;
                        //console.log("activityhistory", count);
                        /* Eligble activities are defined as any match played in the last 20 minutes of current activity */
                        //console.log("res.activities", res.activities);
                        _.each(_.filter(res.activities, function(activity){
                            var diffMins = moment().diff(moment(activity.period),'minutes');
                            return diffMins <= 2000;
                        }), function(activity){
                            var activityId = activity.activityDetails.instanceId;
                            activities.push({
                                activityId: activityId,
                                mapId: activity.activityDetails.referenceId,
                                gamerTags: []
                            });
                        });
                        nextCharacter(null, activities);
                    })
                    .catch(function(){
                        nextCharacter(e, null);
                    });
            }, function(err, results){
                /* comes back as upto 3 arrays [ [], [], [] ] for each character's activities */
                var activities = _.flatten(results);
                console.log(account.displayName, "activities found for", activities.length);
                nextAccount(err, activities);
            });        
        }, function(err, results){
            /* comes back as an array for each account, buddies might play the same activity so merge this array */
            var activities = _.uniqBy(_.flatten(results), function(activity){
                return activity.activityId + " " + activity.mapId;
            });
            console.log("finished running all activities", activities.length);
            next(err, activities);
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
				.catch(function(){
					nextActivity(e, null);
				});
        }, function(err, results){
            console.log("finished running all pgcr reports", activities.length);
            next(err, results);
        });
    } ],
    queryGameClips: [ 'queryAccountsInfo', 'queryActivityHistory', 'queryActivityCarnage', function(results, next){
        var activities = results.queryActivityCarnage;
        /* 
            another async.map goes here to do the final processing
        */
    } ]
};

var concurrency = 10;

async.auto(tasks, concurrency, function(err, results){
    if ( err ) { return console.log(err); } 
    console.log("tasks completed", results.queryActivityCarnage);
});
