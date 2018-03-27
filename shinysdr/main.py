#!/usr/bin/env python

# Copyright 2013, 2014, 2015, 2016, 2017, 2018 Kevin Reid <kpreid@switchb.org>
#
# This file is part of ShinySDR.
# 
# ShinySDR is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
# 
# ShinySDR is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
# 
# You should have received a copy of the GNU General Public License
# along with ShinySDR.  If not, see <http://www.gnu.org/licenses/>.

# pylint: disable=no-member
# (no-member: Twisted reactor)

from __future__ import absolute_import, division, unicode_literals

import argparse
import logging
import sys

from twisted.application.service import IService, MultiService
from twisted.internet import defer
from twisted.internet import reactor as singleton_reactor
from twisted.internet.task import react
from twisted.python import log

# Note that gnuradio-dependent modules are loaded later, to avoid the startup time if all we're going to do is give a usage message
from shinysdr.config import Config, write_default_config, execute_config
from shinysdr.i.dependencies import DependencyTester
from shinysdr.i.persistence import PersistenceFileGlue
from shinysdr.i.poller import the_subscription_context

__all__ = []  # appended later


def main(argv=None, _abort_for_test=False):
    # This function is referenced by the setup.py entry point definition as well as the name=__main__ test below.
    def go(reactor):
        return _main_async(reactor, argv, _abort_for_test)
        
    if _abort_for_test:
        return go(singleton_reactor)
    else:
        react(go)


__all__.append('main')


@defer.inlineCallbacks
def _main_async(reactor, argv=None, _abort_for_test=False):
    if argv is None:
        argv = sys.argv
    
    if not _abort_for_test:
        # Some log messages would be discarded if we did not set up things early.
        configure_logging()
    
    # Option parsing is done before importing the main modules so as to avoid the cost of initializing gnuradio if we are aborting early. TODO: Make that happen for createConfig too.
    argParser = argparse.ArgumentParser(prog=argv[0])
    argParser.add_argument('config_path', metavar='CONFIG',
        help='path of configuration directory or file')
    argParser.add_argument('--create', dest='createConfig', action='store_true',
        help='write template configuration file to CONFIG and exit')
    argParser.add_argument('-g, --go', dest='openBrowser', action='store_true',
        help='open the UI in a web browser')
    argParser.add_argument('--force-run', dest='force_run', action='store_true',
        help='Run DSP even if no client is connected (for debugging).')
    args = argParser.parse_args(args=argv[1:])

    # Verify we can actually run.
    # Note that this must be done before we actually load core modules, because we might get an import error then.
    version_report = yield _check_versions()
    if version_report:
        print >>sys.stderr, version_report
        sys.exit(1)

    # Write config file and exit if asked ...
    if args.createConfig:
        write_default_config(args.config_path)
        log.msg('Created default configuration at: ' + args.config_path)
        sys.exit(0)  # TODO: Consider using a return value or something instead
    
    # ... else read config file
    config_obj = Config(reactor)
    execute_config(config_obj, args.config_path)
    yield config_obj._wait_and_validate()
    
    log.msg('Constructing...')
    app = config_obj._create_app()
    
    reactor.addSystemEventTrigger('during', 'shutdown', app.close_all_devices)
    
    log.msg('Restoring state...')
    pfg = PersistenceFileGlue(
        reactor=reactor,
        root_object=app,
        filename=config_obj._state_filename,
        get_defaults=_app_defaults)
    
    log.msg('Starting web server...')
    services = MultiService()
    for maker in config_obj._service_makers:
        IService(maker(app)).setServiceParent(services)
    services.startService()
    
    log.msg('ShinySDR is ready.')
    
    for service in services:
        # TODO: should have an interface (currently no proper module to put it in)
        service.announce(args.openBrowser)
    
    if args.force_run:
        log.msg('force_run')
        # TODO kludge, make this less digging into guts
        app.get_receive_flowgraph().get_monitor().state()['fft'].subscribe2(lambda v: None, the_subscription_context)
    
    if _abort_for_test:
        services.stopService()
        yield pfg.sync()
        defer.returnValue(app)
    else:
        yield defer.Deferred()  # never fires


def _app_defaults(app):
    """Return a friendly initial state for the app using knowledge of the default config file."""
    state = {}
    
    # TODO: fix fragility of assumptions
    top = app.get_receive_flowgraph()
    sources = top.state()['source_name'].type().get_table()
    restricted = dict(sources)
    if 'audio' in restricted: del restricted['audio']  # typically not RF
    if 'sim' in restricted: del restricted['sim']  # would prefer the real thing
    if 'osmo' in restricted:
        state['source_name'] = 'osmo'
    elif len(restricted.keys()) > 0:
        state['source_name'] = restricted.keys()[0]
    # else out of ideas, let top block pick
    
    return state


def _check_versions():
    t = DependencyTester()
    t.check_module_attr('gnuradio.blocks', 'GNU Radio', 'rotator_cc')
    t.check_module_attr('twisted.internet.task', 'Python library Twisted', 'react')
    t.check_module_attr('txws', 'Python library txWS', 'WebSocketProtocol.setBinaryMode')
    t.check_module_attr('six', 'Python library six', 'PY2')
    t.check_module('ephem', 'Python library PyEphem')
    t.check_module('serial', 'Python library PySerial')
    t.check_jsdep_file(__file__, 'deps/require.js', 'RequireJS')
    t.check_jsdep_file(__file__, 'deps/text.js', 'RequireJS')
    t.check_jsdep_file(__file__, 'deps/jasmine', 'Jasmine')
    return t.report()


def configure_logging():
    # TODO: Consult best practices for Python and Twisted logging.
    # TODO: Logs which are observably relevant should be sent to the client (e.g. the warning of refusing to have more receivers active)
    logging.basicConfig(level=logging.INFO)
    log.startLoggingWithObserver(log.PythonLoggingObserver(loggerName='shinysdr').emit, False)


if __name__ == '__main__':
    main()
