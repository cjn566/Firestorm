const discoveries = require('./discovery').discoveries;
const archiver = require('archiver');
const _ = require('lodash');

module.exports = function (app) {

  app.get("/discover", function (req, res) {
    res.send(_.map(discoveries, function (v, k) {
      let res = _.pick(v, ['lastSeen', 'address']);
      _.assign(res, v.controller.props); 
      return res;
    }));
  })

  app.post("/command", function (req, res) {
    if (req.body && req.body.ids && req.body.command) {
      _.each(req.body.ids, id => {
        id = String(id);
        let controller = discoveries[id] && discoveries[id].controller;
        if (controller) {
          controller.setCommand(req.body.command);
        }
      })
      res.send("ok");
    } else {
      res.status(400).send("missing ids or command");
    }
  })


  app.get("/command", function (req, res) {
    if (req.query.command && req.query.ids) {
      try {
        let command = JSON.parse(req.query.command);
        let ids = req.query.ids.split(',');
        _.each(ids, id => {
          let controller = discoveries[id] && discoveries[id].controller;
          if (controller) {
            controller.setCommand(command);
          }
        })
        res.send("ok");
      } catch (err) {
        res.status(400).send("unable to parse json:" + req.query.command);
      }
    } else {
      res.status(400).send("missing ids or command");
    }
  })

  app.post("/reload", function (req, res) {
    _.each(discoveries, d => {
      if (d.controller) {
        d.controller.reload();
      }
    })
    res.send("ok");
  })

  app.post("/clonePrograms", async function (req, res) {
    try {
      console.log("clonePrograms", req.body);
      let from = String(req.body.from);
      let to = req.body.to;
      if (!(from && to)) {
        res.status(400).send("missing from or to");
        return;
      }

      let source = discoveries[from];
      if (!(source && source.controller)) {
        res.status(400).send("unable to find source");
        return;
      }

      //reload patterns for from and to in case something changed. don't want to work on a stale copy!
      source.controller.reload();
      to.map(id => {
        id = String(id);
        let controller = discoveries[id] && discoveries[id].controller;
        if (controller) {
          controller.reload();
        }
      });
      //TODO HACK wait for reload to work. it would be better to listen to a refresh event or something
      await new Promise(resolve => setTimeout(resolve, 250));

      let sourceKeys = _.map(source.controller.props.programList, "id");
      //first delete any extra patternIds from all destinations (do this across controllers in parallel, but each one at a time)
      await Promise.all(to.map(async id => {
        id = String(id);
        let controller = discoveries[id] && discoveries[id].controller;
        if (controller) {
          //delete any extra patternIds
          let destKeys = _.map(controller.props.programList, "id");
          let keysToRemove = _.differenceWith(destKeys, sourceKeys, _.isEqual);
          console.log("destKeys", destKeys)
          console.log("sourceKeys", sourceKeys);
          console.log("keysToRemove", keysToRemove);
          //do this one at a time to avoid flooding PB with too many simultaneous requests
          //good old for loop works better than a forEach for await
          for (let i = 0; i < keysToRemove.length; i++) {
            await controller.deleteProgram(keysToRemove[i]);
          }
        }
      }));

      //now load each program one at a time
      //then write/overwrite all ids from source (content may have changed even if id is the same)
      //again, do this one at a time to avoid flooding PB with too many simultaneous requests
      //good old for loop works better than a forEach for await
      for (let i = 0; i < sourceKeys.length; i++) {
        let programId = sourceKeys[i];
        let data = await source.controller.getProgramBinary(programId);
        await Promise.all(to.map(async id => {
          id = String(id);
          let controller = discoveries[id] && discoveries[id].controller;
          if (controller) {
            return controller.putProgramBinary(programId, data);
          }
        }));
      }
      //send the response
      res.send("ok");

      //trigger a reload so that we'll have the updated pattern list
      to.forEach(id => {
        discoveries[id] && discoveries[id].controller && discoveries[id].controller.reload()
      })

    } catch (err) {
      console.error("unable to clone patterns", err);
      res.status(500).send("unable to clone patterns");
    }
  })

  // export binary representations of all patterns on a Pixelblaze as a zip file
  app.get("/controllers/:sourceId/dump", async function (req, res) {
    try {
      let sourceId = String(req.params.sourceId);

      if (!(sourceId)) {
        res.status(400).send("missing sourceId");
        return;
      }

      let source = discoveries[sourceId];
      if (!(source && source.controller)) {
        res.status(400).send("unable to find source");
        return;
      }

      //reload patterns in case something changed. don't want to work on a stale copy!
      source.controller.reload();

      //TODO HACK wait for reload to work. it would be better to listen to a refresh event or something
      await new Promise(resolve => setTimeout(resolve, 250));

      let sourceKeys = _.map(source.controller.props.programList, "id");

      //set up zip file to assemble and download
      let archive = archiver('zip');
      let rootDir = source.controller.props.name || "Pixelblaze_" + sourceId;
      res.attachment(rootDir + '.zip');
      archive.pipe(res);

      //load each program one at a time and append into the zip file. good old
      //for loop works better than a forEach for await
      for (let i = 0; i < sourceKeys.length; i++) {
        let programId = sourceKeys[i];
        let programData = await source.controller.getProgramBinary(programId);
        archive.append(programData, { name: programId});
        let controlsData = await source.controller.getProgramBinary(programId, ".c");
        archive.append(controlsData, { name: programId + ".c"});
      }
      archive.finalize();

    } catch (err) {
      console.error("unable to dump patterns", err);
      res.status(500).send("unable to dump patterns");
    }
  })


  // app.post('/deleteProgram'function (req, res) {
  //   let programId = req.body.programId;
  //   let from = req.body.from;
  // })

}
