# Copyright 2014, 2015, 2016 Kevin Reid <kpreid@switchb.org>
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

"""
See also test_main.py.
"""

from __future__ import absolute_import, division, unicode_literals

import os.path
import shutil
import tempfile

from twisted.internet import reactor as the_reactor
from twisted.internet import defer
from twisted.trial import unittest
from zope.interface import implementer

from shinysdr import devices
from shinysdr.config import Config, ConfigException, ConfigTooLateException, execute_config, write_default_config
from shinysdr.i.roots import IEntryPoint
from shinysdr.values import ExportedState


def StubDevice():
    """Return a valid trivial device."""
    return devices.Device(components={})


class TestConfigObject(unittest.TestCase):
    def setUp(self):
        self.config = Config(the_reactor)
    
    # TODO: In type error tests, also check message once we've cleaned them up.
    
    # --- General functionality ---
    
    def test_reactor(self):
        self.assertEqual(self.config.reactor, the_reactor)
    
    # TODO def test_wait_for(self):
    
    @defer.inlineCallbacks
    def test_validate_succeed(self):
        self.config.devices.add(u'foo', StubDevice())
        d = self.config._wait_and_validate()
        self.assertIsInstance(d, defer.Deferred)  # don't succeed trivially
        yield d
    
    # TODO: Test "No network service defined"; is a warning not an error

    # --- Persistence ---
    
    @defer.inlineCallbacks
    def test_persist_too_late(self):
        yield self.config._wait_and_validate()
        self.assertRaises(ConfigTooLateException, lambda:
            self.config.persist_to_file('foo'))
        self.assertEqual({}, self.config.devices._values)
    
    def test_persist_none(self):
        self.assertEqual(None, self.config._state_filename)

    def test_persist_ok(self):
        self.config.persist_to_file('foo')
        self.assertEqual('foo', self.config._state_filename)

    def test_persist_duplication(self):
        self.config.persist_to_file('foo')
        self.assertRaises(ConfigException, lambda: self.config.persist_to_file('bar'))
        self.assertEqual('foo', self.config._state_filename)

    # --- Devices ---
    
    @defer.inlineCallbacks
    def test_device_too_late(self):
        yield self.config._wait_and_validate()
        self.assertRaises(ConfigTooLateException, lambda:
            self.config.devices.add(u'foo', StubDevice()))
        self.assertEqual({}, self.config.devices._values)
    
    def test_device_key_ok(self):
        dev = StubDevice()
        self.config.devices.add(u'foo', dev)
        self.assertEqual({u'foo': dev}, self.config.devices._values)
        self.assertEqual(unicode, type(self.config.devices._values.keys()[0]))
    
    def test_device_key_string_ok(self):
        dev = StubDevice()
        self.config.devices.add('foo', dev)
        self.assertEqual({u'foo': dev}, self.config.devices._values)
        self.assertEqual(unicode, type(self.config.devices._values.keys()[0]))
    
    def test_device_key_type(self):
        self.assertRaises(ConfigException, lambda:
            self.config.devices.add(StubDevice(), StubDevice()))
        self.assertEqual({}, self.config.devices._values)
    
    def test_device_key_duplication(self):
        dev = StubDevice()
        self.config.devices.add(u'foo', dev)
        self.assertRaises(ConfigException, lambda:
            self.config.devices.add(u'foo', StubDevice()))
        self.assertEqual({u'foo': dev}, self.config.devices._values)
    
    def test_device_empty(self):
        self.assertRaises(ConfigException, lambda:
            self.config.devices.add(u'foo'))
        self.assertEqual({}, self.config.devices._values)
    
    # --- serve_web ---
    
    @defer.inlineCallbacks
    def test_web_too_late(self):
        yield self.config._wait_and_validate()
        self.assertRaises(ConfigTooLateException, lambda:
            self.config.serve_web(http_endpoint='tcp:8100', ws_endpoint='tcp:8101'))
        self.assertEqual({}, self.config.devices._values)
    
    def test_web_ok(self):
        self.config.serve_web(http_endpoint='tcp:8100', ws_endpoint='tcp:8101')
        self.assertEqual(1, len(self.config._service_makers))
    
    def test_web_root_cap_empty(self):
        self.assertRaises(ConfigException, lambda:
            self.config.serve_web(http_endpoint='tcp:8100', ws_endpoint='tcp:8101', root_cap=''))
        self.assertEqual([], self.config._service_makers)
    
    def test_web_root_cap_none(self):
        self.config.serve_web(http_endpoint='tcp:0', ws_endpoint='tcp:0')
        self.assertEqual(1, len(self.config._service_makers))
        # Actually instantiating the service. We need to do this to check if the root_cap value was processed correctly.
        service = self.config._service_makers[0](DummyAppRoot())
        self.assertEqual('/public/', service.get_host_relative_url())
    
    # --- serve_ghpsdr ---
    
    @defer.inlineCallbacks
    def test_ghpsdr_too_late(self):
        yield self.config._wait_and_validate()
        self.assertRaises(ConfigTooLateException, lambda:
            self.config.serve_ghpsdr())
        self.assertEqual({}, self.config.devices._values)
    
    def test_ghpsdr_ok(self):
        self.config.serve_ghpsdr()
        self.assertEqual(1, len(self.config._service_makers))
    
    # --- Misc options ---
    
    @defer.inlineCallbacks
    def test_server_audio_too_late(self):
        yield self.config._wait_and_validate()
        self.assertRaises(ConfigTooLateException, lambda:
            self.config.set_server_audio_allowed(True))
        self.assertEqual({}, self.config.devices._values)
    
    # TODO test rest of config.set_server_audio_allowed

    @defer.inlineCallbacks
    def test_stereo_too_late(self):
        yield self.config._wait_and_validate()
        self.assertRaises(ConfigTooLateException, lambda:
            self.config.set_stereo(True))
        self.assertEqual({}, self.config.devices._values)
    
    # TODO test rest of config.set_stereo
    
    # --- Features ---
    
    def test_features_unknown(self):
        self.assertRaises(ConfigException, lambda:
            self.config.features.enable('bogus'))
        self.assertFalse('bogus' in self.config.features._state)
    
    @defer.inlineCallbacks
    def test_features_enable_too_late(self):
        yield self.config._wait_and_validate()
        self.assertRaises(ConfigTooLateException, lambda:
            self.config.features.enable('_test_disabled_feature'))
        self.assertFalse(self.config.features._get('_test_disabled_feature'))
    
    @defer.inlineCallbacks
    def test_features_disable_too_late(self):
        yield self.config._wait_and_validate()
        self.assertRaises(ConfigTooLateException, lambda:
            self.config.features.enable('_test_enabled_feature'))
        self.assertTrue(self.config.features._get('_test_enabled_feature'))
    
    # --- Databases ---
    
    # TODO test config.databases.add_directory
    # TODO test config.databases.add_writable_database


class TestConfigFiles(unittest.TestCase):
    def setUp(self):
        self.__temp_dir = tempfile.mkdtemp(prefix='shinysdr_test_config_tmp')
        self.__config_name = os.path.join(self.__temp_dir, 'config')
        self.__config = Config(the_reactor)
    
    def tearDown(self):
        shutil.rmtree(self.__temp_dir)
    
    def __dirpath(self, *paths):
        return os.path.join(self.__config_name, *paths)
    
    def test_config_file(self):
        with open(self.__config_name, 'w') as f:
            f.write('config.features.enable("_test_disabled_feature")')
        # DB CSV file we expect NOT to be loaded
        os.mkdir(os.path.join(self.__temp_dir, 'dbs'))
        with open(os.path.join(self.__temp_dir, 'dbs', 'foo.csv'), 'w') as f:
            f.write('Frequency,Name')

        execute_config(self.__config, self.__config_name)
        
        # Config python was executed
        self.assertTrue(self.__config.features._get('_test_disabled_feature'))
        
        # Config-directory-related defaults were not set
        self.assertEquals(None, self.__config._state_filename)
        self.assertEquals(get_default_dbs().viewkeys(), self.__config.databases._get_read_only_databases().viewkeys())
    
    def test_config_directory(self):
        os.mkdir(self.__config_name)
        with open(self.__dirpath('config.py'), 'w') as f:
            f.write('config.features.enable("_test_disabled_feature")')
        os.mkdir(self.__dirpath('dbs-read-only'))
        with open(self.__dirpath('dbs-read-only', 'foo.csv'), 'w') as f:
            f.write('Frequency,Name')
        execute_config(self.__config, self.__config_name)
        
        # Config python was executed
        self.assertTrue(self.__config.features._get('_test_disabled_feature'))
        
        # Config-directory-related defaults were set
        self.assertEquals(self.__dirpath('state.json'), self.__config._state_filename)
        self.assertIn('foo.csv', self.__config.databases._get_read_only_databases())
    
    def test_default_config(self):
        write_default_config(self.__config_name)
        self.assertTrue(os.path.isdir(self.__config_name))
        
        # Don't try to open a real device
        with open(self.__dirpath('config.py'), 'r') as f:
            conf_text = f.read()
        DEFAULT_DEVICE = "OsmoSDRDevice('')"
        self.assertIn(DEFAULT_DEVICE, conf_text)
        conf_text = conf_text.replace(DEFAULT_DEVICE, "OsmoSDRDevice('file=/dev/null,rate=100000')")
        with open(self.__dirpath('config.py'), 'w') as f:
            f.write(conf_text)
        
        execute_config(self.__config, self.__config_name)
        
        self.assertTrue(os.path.isdir(self.__dirpath('dbs-read-only')))
        return self.__config._wait_and_validate()


def get_default_dbs():
    config_obj = Config(the_reactor)
    return config_obj.databases._get_read_only_databases()


class DummyAppRoot(ExportedState):
    def get_session(self):
        return StubEntryPoint()
    
    def get_receive_flowgraph(self):
        return None


@implementer(IEntryPoint)
class StubEntryPoint(object):
    def entry_point_is_deleted(self):
        return False
