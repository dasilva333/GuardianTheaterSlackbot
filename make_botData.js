var sqlite3 = require('sqlite3').verbose(),
	fs = require("fs"),
	_ = require("lodash");
	
function extractItems(callback){	
	var db = new sqlite3.Database("mobileWorldContent_en.db");
	db.all("SELECT * FROM DestinyActivityBundleDefinition", function(err, rows) {
		var obj = {};
		rows.forEach(function (row) {  
			var entry = JSON.parse(row.json);
			obj[entry["bundleHash"]] = entry;
		});
		callback(obj);
	});
}


tgd = {};

extractItems(function(_activityDefs){	
    fs.writeFileSync("definitions.js", "module.exports="+JSON.stringify(_activityDefs, null, 4)+";");
    console.log("new definitions file written");
});