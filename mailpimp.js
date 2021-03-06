var config = require('./config');

var Maki = require('maki');
var mailpimp = new Maki( config );

// TODO: should this be a maki feature?
var Agency = require('mongoose-agency');

var Passport = require('maki-passport-local');
var passport = new Passport({
  resource: 'Person'
});

mailpimp.use( passport );

var async = require('async');
var schedule = require('node-schedule');
var feed = require('feed-read');
var unfluff = require('unfluff');

var Person = mailpimp.define('Person', {
  attributes: {
    username: { type: String , max: 35 },
    email: { type: String , max: 200 },
    created: { type: Date , default: Date.now },
  },
  icon: 'user'
});

var Subscription = mailpimp.define('Subscription', {
  attributes: {
    name: {
      given: { type: String , max: 200 },
      family: { type: String , max: 200 },
      alias: { type: String , max: 200 }
    },
    email: { type: String , max: 200 },
    created: { type: Date , default: Date.now },
    validated: { type: Date },
    status: { type: String , enum: ['created', 'confirmed', 'canceled'], default: 'created' },
    _list: { type: mailpimp.mongoose.SchemaTypes.ObjectId , ref: 'List' },
  },
  icon: 'inbox'
});

var List = mailpimp.define('List', {
  attributes: {
    name: { type: String , required: true , max: 200 },
    source: { type: String , max: 200 },
    created: { type: Date , default: Date.now },
    from: { type: String , max: 200 , required: true },
    _template: { type: mailpimp.mongoose.SchemaTypes.ObjectId , ref: 'List' },
    stats: {
      subscribers: { type: Number, default: 0 }
    }
  },
  icon: 'newspaper'
});

var Mail = mailpimp.define('Mail', {
  attributes: {
    subject: { type: String , max: 200 },
    content: { type: String },
    //created: { type: Date , default: Date.now },
    data:    {},
    _list:   { type: mailpimp.mongoose.SchemaTypes.ObjectId , ref: 'List' },
  },
  icon: 'mail'
});

var Task = mailpimp.define('Task', {
  attributes: {
    status: { type: String , enum: ['pending', 'sending', 'sent', 'failed'], default: 'pending' },
    sender: { type: String , max: 200 },
    recipient: { type: String , max: 200 },
    subject: { type: String , max: 200 },
    content: { type: String },
    data: {},
    _mail: { type: mailpimp.mongoose.SchemaTypes.ObjectId , ref: 'Mail' },
    _list: { type: mailpimp.mongoose.SchemaTypes.ObjectId , ref: 'List' },
  },
  icon: 'setting'
});

Task.on('create', function(task) {
  mailpimp.agency.publish('email', task, function(err) {
    if (err) console.error(err);

    var ops = [];
    if (err) {
      ops.push({ op: 'replace', path: '/status', value: 'failed' });
    } else {
      ops.push({ op: 'replace', path: '/status', value: 'sent' });
    }
    Task.patch({ _id: task._id }, ops, function(err) {
      if (err) console.error(err);
    });
  });
});

var Item = mailpimp.define('Item', {
  attributes: {
    url: { type: String , required: true },
    created: { type: Date , default: Date.now },
    _list: { type: mailpimp.mongoose.SchemaTypes.ObjectId , ref: 'List' },
  },
  icon: 'feed'
});

var Template = mailpimp.define('Template', {
  attributes: {
    name: { type: String , max: 200 },
    content: { type: String }
  }
});

Subscription.on('create', function(subscription) {
  // TODO: send confirmation emails, double opt-in
  // TODO: expose aggregate-like function in Maki
  Subscription.Model.aggregate([
    { $match: { _list: subscription._list } },
    { $group: {
      _id: '$_list',
      count: { $sum: 1 }
    } }
  ], function(err, stats) {
    if (err) return console.error(err);
    if (!stats.length) return;

    List.Model.update({
      _id: subscription._list
    }, {
      $set: { 'stats.subscribers': stats[0].count }
    }, function(err) {
      if (err) console.error(err);
    });
  });
});

Mail.post('create', function(done) {
  var mail = this;
  Subscription.query({ _list: mail._list }, {
    populate: '_list'
  }, function(err, subscriptions) {
    if (err) return done(err);
    subscriptions.forEach(function(subscription) {
      var name = subscription.name.alias || subscription.name.first || 'friend';
      mail.content = mail.content.replace('{{name}}', name);

      Task.create({
        sender: subscription._list.from,
        recipient: subscription.email,
        subject: mail.subject,
        content: mail.content,
        data: mail.data,
        _list: mail._list,
        _mail: mail._id
      }, function(err, task) {
        return done(err);
      });
    });
  });
});

mailpimp.start(function() {
  mailpimp.email = require('emailjs').server.connect( config.mail );

  mailpimp.agency = new Agency( mailpimp.datastore.db );
  mailpimp.agency.subscribe('email', function(task, done) {
    Task.patch({ _id: task._id }, [
      { op: 'replace', path: '/status', value: 'sending' }
    ], function(err) {
      if (err) return done(err);

      var mail = {
        text: task.content,
        to: task.recipient,
        from: task.sender,
        subject: task.subject
      };

      if (task.data) {
        mail.text = unfluff( task.content ).text + '\n\nRead More: ' + task.data.link;
        // TODO: templates.
        mail.attachment = [
          { data: '<html><h1><a href="'+task.data.link+'">'+task.subject+'</a></h1>' + task.content + '<p><a href="'+task.data.link+'">Read More &raquo;</a></p></html>', alternative: true }
        ];
      }

      mailpimp.email.send( mail , function(err, message) {
        done(err);
      });

    });
  });

  var rule = new schedule.RecurrenceRule();
  rule.minute = 0;
  rule.hour = 15;

  var updater = schedule.scheduleJob(rule, function() {
    List.query({ source: { $exists: true } }, function(err, lists) {
      lists.forEach(function(list) {
        feed( list.source , function(err, entries) {
          entries.forEach(function(entry) {
            Item.get({ url: entry.link }, function(err, item) {
              if (item) return;
              Item.create({
                url: entry.link
              }, function(err, item) {
                Mail.create({
                  subject: entry.title,
                  content: entry.content,
                  data: { link: entry.link },
                  _list: list._id
                });
              });
            });
          });
        });
      });
    });
  });

});
