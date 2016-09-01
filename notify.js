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
var clip = JSON.parse(fs.readFileSync(".//clip.json"));

var clipUrl = clip.gameClipUris[0].uri;
var gt = "SmogElite";
var description = 'Recording by ' + gt + ' recorded ' + moment(clip.dateRecorded).fromNow();
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