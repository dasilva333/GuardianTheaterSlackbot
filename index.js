/* Define Libraries */
var fs = require("fs");
var _ = require("lodash");
var request = require('request');
var slack = require("slack-notify");
var moment = require("moment");
var destiny = require("destiny-client").default("5cae9cdee67a42848025223b4e61f929");

/* Define Variables */
var configFile = ".\\config.json";
var guardianTheaterApiEndpoint = "http://guardian.theater/api/GetClipsPlayerActivity/"; //chrisfried/5364990060
var config = JSON.parse(fs.readFileSync(configFile));
slack = slack(config.SlackWebhook);

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
                    var characters = _.map(res.characters, function(c){
                        return c.characterBase.characterId;
                    });
                    _.each(characters, function(characterId){
                        //console.log("http://www.bungie.net/Platform/Destiny/Stats/ActivityHistory/%s/%s/%s/", 1, account.membershipId, account.membershipId)
                        destiny
                            .ActivityHistory({
                                membershipType: 1,
                                membershipId: account.membershipId,
                                characterId: characterId,
                                mode: "AllPVP"
                            })
                            .then(res => { 
                                if ( characterId == "2305843009265624290" ){
                                    var activityIds = _.take(_.map(res.activities, function(activity){
                                        return activity.activityDetails.instanceId;
                                    }), 2);
                                    //console.log("activityIds", activityIds);
                                    _.each(activityIds, function(activityId){
                                        destiny
                                            .CarnageReport({
                                                activityId: activityId
                                            })
                                            .then(res => {               
                                                //console.log("entries", res.entries.length);
                                                var gamerTags = _.map(res.entries, function(e){
                                                    return e.player.destinyUserInfo.displayName;
                                                });
                                                _.each(gamerTags, function(gt){
                                                    request(guardianTheaterApiEndpoint + gt + "/" + activityId, function (error, response, body) {
                                                    //console.log(guardianTheaterApiEndpoint + gt + "/" + activityId);
                                                      if (!error && response.statusCode == 200) {
                                                        var clips = JSON.parse(body);
                                                        if (clips.length){
                                                            //console.log(JSON.stringify(clips, null, 2));
                                                            _.each(clips, function(clip){
                                                                //fs.writeFileSync("./clip.json", JSON.stringify(clip));
                                                                var clipUrl = clip.gameClipUris[0].uri;
                                                                var description = 'Game Clip by ' + gt + ' recorded ' + moment(clip.dateRecorded).fromNow();
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
                                                                        { title: 'GamerTag', value: gt, short: true },
                                                                        { title: 'Record At', value: moment(clip.dateRecorded).format('MMMM Do, h:mm a'), short: true }
                                                                      ]
                                                                    }
                                                                  ]
                                                                });
                                                                console.log("sent clip");
                                                            });
                                                        }
                                                      }
                                                    });
                                                });
                                            })
                                    });
                                }
                            })
                            .catch(err => { /* handle error */ });  
                    });                    
                })
                .catch(err => { /* handle error */ });    
          }        
     })
     .catch(err => { /* handle error */ });     
});
